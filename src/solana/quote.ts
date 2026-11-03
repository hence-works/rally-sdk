/**
 * Exact quotes for the Rally Solana router and for the creator's first buy.
 *
 * A swap quote replays Raydium's `swap_internal` over the pool's real state and the real tick
 * arrays the swap crosses (`clmm-swap.ts`), then applies the Rally router fee exactly as
 * `swap.rs` does. It reads liquidity from the chain, not from the launch's own positions:
 * anyone can LP a Raydium pool, and a quote built from the planned positions would be wrong
 * the moment they do. If a needed account cannot be read, or the pool uses something the replay
 * does not model, the quote REFUSES (`QUOTE_UNAVAILABLE`) instead of approximating.
 *
 * Supports exact-input and Wave 0 exact-output swaps.
 */

import { getAddressDecoder, type Address, type GetMultipleAccountsApi, type Rpc } from "@solana/kit";
import { RallyError } from "../errors";
import { fetchClusterTime, fetchConfig, fetchLaunch, fetchQuoteConfig, type SolanaRpc } from "./accounts";
import {
  MAX_SQRT_PRICE_X64,
  MIN_SQRT_PRICE_X64,
  Q128,
} from "./clmm";
import {
  TICK_ARRAY_ACCOUNT_LEN,
  TickArrayMissing,
  decodeClmmPool,
  decodeClmmTickArray,
  firstArrayStart,
  initializedArrayStartsAfter,
  simulateExactIn,
  simulateExactOut,
  type ClmmPoolState,
  type ClmmTickArray,
} from "./clmm-swap";
import { RAYDIUM_CLMM_DEVNET, RALLY_SOLANA_PROTOCOL_PROGRAM_ID } from "./constants";
import { buildCurve, planFirstBuy, presetSegments, type CurveLayout, type FirstBuyPlan, type PlannedPosition } from "./curve";
import { SOLANA_DEPLOYMENTS } from "./deployments.generated";
import { raydiumPdas } from "./pda";
import type { CurveSegment, LaunchAccount } from "./types";

/** The slice of the kit RPC a quote reads with. Any `createSolanaRpc(...)` satisfies it. */
export type SolanaQuoteRpc = SolanaRpc & Rpc<GetMultipleAccountsApi>;

const UNSET = "11111111111111111111111111111111";
const BPS = 10_000n;
const addrDecoder = getAddressDecoder();
const toAddress = (b: Uint8Array) => addrDecoder.decode(b);

const unavailable = (message: string, details?: Record<string, unknown>) =>
  new RallyError("QUOTE_UNAVAILABLE", message, details ? { details } : undefined);

// ── router fee ───────────────────────────────────────────────────────────────

/**
 * The router fee in bps at a cluster unix time: the launch's anti-snipe decay while on the
 * curve, zero from breakout (program `Launch::router_fee_bps`). `timestamp` is the CLUSTER's
 * clock (`fetchClusterTime`), the one the program reads.
 */
export function routerFeeBpsAt(launch: Pick<LaunchAccount, "phase" | "schedule" | "launchedAt">, timestamp: bigint): bigint {
  if (launch.phase !== "Curve") return 0n;
  const s = launch.schedule;
  const start = BigInt(s.curveFeeStartBps);
  const end = BigInt(s.curveFeeEndBps);
  const decay = BigInt(s.curveFeeDecay);
  let elapsed = timestamp - launch.launchedAt;
  if (elapsed < 0n) elapsed = 0n;
  if (decay === 0n || elapsed >= decay || start <= end) return end;
  return start - ((start - end) * elapsed) / decay;
}

/**
 * `floor(amountOut * (10000 - slippageBps) / 10000)`: the least output a swap must deliver.
 * `slippageBps` is explicit and has no default. Throws when the result would be below 1 (the
 * program rejects `minOut == 0`).
 */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new RallyError("INVALID_AMOUNT", `slippageBps must be an integer in 0..9999, got ${slippageBps}`);
  }
  const min = (amountOut * (BPS - BigInt(slippageBps))) / BPS;
  if (min < 1n) {
    throw new RallyError("INVALID_AMOUNT", "The quoted output is too small to bound with this slippage (minOut would be 0)");
  }
  return min;
}

/** Ceiling input bound for an exact-output quote. No implicit tolerance. */
export function applySlippageExactOut(amountIn: bigint, slippageBps: number): bigint {
  if (typeof amountIn !== "bigint" || amountIn <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) {
    throw new RallyError("INVALID_AMOUNT", "Positive input and integer slippageBps in 0..9999 required");
  }
  const result = (amountIn * (BPS + BigInt(slippageBps)) + BPS - 1n) / BPS;
  if (result >= 1n << 64n) throw new RallyError("INVALID_AMOUNT", "maxIn exceeds u64");
  return result;
}

function grossUpFee(net: bigint, bps: bigint): bigint {
  if (bps < 0n || bps >= BPS) throw new RallyError("INVALID_AMOUNT", "Invalid router fee");
  return (net * bps + (BPS - bps) - 1n) / (BPS - bps);
}

// ── swap quote ───────────────────────────────────────────────────────────────

export interface SolanaSwapQuote {
  /** Absent on legacy exact-input quotes; exact-output quotes always set this. */
  exactOutput?: boolean;
  maxIn?: bigint;
  side: "buy" | "sell";
  mint: Address;
  quoteMint: Address;
  pool: Address;
  /** The input as typed: quote base units for a buy (router fee included), launch tokens (6dp) for a sell. */
  amountIn: bigint;
  /** Input actually taken. Equals `amountIn` unless the pool runs to its price limit (a partial fill). */
  amountInUsed: bigint;
  /** Output the trader receives: launch tokens for a buy, NET quote for a sell. */
  amountOut: bigint;
  /** Least output to accept, present only when `slippageBps` was passed. Feed it to `prepareBuy` / `prepareSell`. */
  minOut?: bigint;
  slippageBps?: number;
  fees: {
    /** Router (anti-snipe) fee in bps at `timestamp`; 0 after breakout. */
    routerFeeBps: bigint;
    /** Router fee actually charged, in quote base units. */
    routerFee: bigint;
    /** Raydium pool fee, in quote base units (`collect_fee_on = Token1Only`: always quote). */
    poolFee: bigint;
    /** Raydium `trade_fee_rate` over 1_000_000. */
    poolFeeRate: bigint;
    /** `routerFee + poolFee`. */
    total: bigint;
  };
  /**
   * How far the fill's average price (fees excluded) is from the spot price before it, in bps,
   * rounded down: a buy fills above spot, a sell below it.
   */
  priceImpactBps: bigint;
  startSqrtPriceX64: bigint;
  endSqrtPriceX64: bigint;
  startTick: number;
  endTick: number;
  /** The cluster unix time the router fee was computed for. */
  timestamp: bigint;
  /** Tick arrays the swap crosses, in the order the program needs them as remaining accounts. */
  tickArrays: Address[];
  tickArrayStarts: number[];
}

export interface QuoteStateInput {
  side: "buy" | "sell";
  mint: Address;
  pool: Address;
  launch: LaunchAccount;
  poolState: ClmmPoolState;
  tradeFeeRate: bigint;
  getTickArray: (start: number) => ClmmTickArray | undefined;
  amountIn: bigint;
  timestamp: bigint;
  slippageBps?: number;
  /** Internal/public offline selector: amountIn then carries the desired output. Prefer quoteExactOutFromState. */
  exactOutput?: boolean;
}

export type QuoteExactOutStateInput = Omit<QuoteStateInput, "amountIn" | "exactOutput"> & { amountOut: bigint };
export function quoteExactOutFromState(i: QuoteExactOutStateInput): Omit<SolanaSwapQuote, "tickArrays"> {
  return quoteSwapFromState({ ...i, amountIn: i.amountOut, exactOutput: true });
}

/**
 * The pure core of a swap quote: everything is passed in, nothing is read. Returns the quote
 * with `tickArrays` empty (addresses need the PDA derivation, which is async); `quoteBuySolana`
 * and `quoteSellSolana` fill them in. Useful offline, and for an indexer holding the state.
 */
export function quoteSwapFromState(i: QuoteStateInput): Omit<SolanaSwapQuote, "tickArrays"> {
  const { launch, poolState } = i;
  const buy = i.side === "buy";
  if (poolState.mint0 !== launch.mint || poolState.mint1 !== launch.quoteMint) {
    throw new RallyError("INVALID_ACCOUNT_DATA", "The pool is not this launch's (mint orientation mismatch)");
  }
  if (typeof i.amountIn !== "bigint" || !(i.amountIn > 0n && i.amountIn < 1n << 64n)) {
    throw new RallyError("INVALID_AMOUNT", `amountIn must be in 1..2^64-1: ${i.amountIn}`);
  }
  const feeBps = routerFeeBpsAt(launch, i.timestamp);

  // Buy: the router fee comes off the top of what was typed, the pool sees the rest.
  const exactOutput = i.exactOutput === true;
  const routerFeeUpFront = exactOutput ? 0n : buy ? (i.amountIn * feeBps) / BPS : 0n;
  const poolIn = i.amountIn - routerFeeUpFront;
  if (poolIn <= 0n) throw new RallyError("INVALID_AMOUNT", "The router fee consumes the whole input");

  const simInput = {
    pool: poolState,
    tradeFeeRate: i.tradeFeeRate,
    getTickArray: i.getTickArray,
    amountIn: poolIn,
    zeroForOne: !buy,
    // The router's own price limits (swap.rs `do_swap`).
    sqrtPriceLimitX64: buy ? MAX_SQRT_PRICE_X64 - 1n : MIN_SQRT_PRICE_X64 + 1n,
  };
  const poolOut = i.amountIn + (exactOutput && !buy ? grossUpFee(i.amountIn, feeBps) : 0n);
  if (exactOutput && poolOut >= 1n << 64n) throw new RallyError("INVALID_AMOUNT", "Gross output exceeds u64");
  const sim = exactOutput ? simulateExactOut({ ...simInput, amountOut: poolOut }) : simulateExactIn(simInput);

  let amountOut: bigint;
  let amountInUsed: bigint;
  let routerFee: bigint;
  let spotCostQuote: bigint; // quote moved at the pool, fees excluded
  let tokens: bigint;
  if (buy) {
    // A partial fill refunds the router fee in proportion (swap.rs `buy`).
    routerFee = exactOutput ? grossUpFee(sim.amountConsumed, feeBps) : routerFeeUpFront - (routerFeeUpFront * (poolIn - sim.amountConsumed)) / poolIn;
    amountInUsed = sim.amountConsumed + routerFee;
    amountOut = sim.amountOut;
    tokens = sim.amountOut;
    spotCostQuote = sim.amountConsumed - sim.poolFee;
  } else {
    // Sell: Raydium pays out the quote net of the pool fee; the router takes its cut of that.
    const gross = sim.amountOut;
    routerFee = exactOutput ? grossUpFee(i.amountIn, feeBps) : (gross * feeBps) / BPS;
    amountOut = gross - routerFee;
    amountInUsed = sim.amountConsumed;
    tokens = sim.amountConsumed;
    spotCostQuote = gross + sim.poolFee;
    if (amountOut <= 0n) throw new RallyError("INVALID_AMOUNT", "The router fee consumes the whole output");
  }
  if (amountOut <= 0n) throw new RallyError("INVALID_AMOUNT", "Amount is too small: the swap would deliver nothing");
  if (amountInUsed >= 1n << 64n) throw new RallyError("INVALID_AMOUNT", "Required input exceeds u64");

  // Price impact: average fill price vs the spot before the swap, both as quote-per-token ratios.
  const spot = poolState.sqrtPriceX64 * poolState.sqrtPriceX64; // quote/token * 2^128
  const exec = (spotCostQuote * Q128 * BPS) / (tokens * spot); // exec/spot in bps
  const impact = buy ? (exec > BPS ? exec - BPS : 0n) : exec < BPS ? BPS - exec : 0n;

  const quote: Omit<SolanaSwapQuote, "tickArrays"> = {
    side: i.side,
    mint: i.mint,
    quoteMint: launch.quoteMint,
    pool: i.pool,
    amountIn: exactOutput ? amountInUsed : i.amountIn,
    ...(exactOutput ? { exactOutput: true } : {}),
    amountInUsed,
    amountOut,
    fees: {
      routerFeeBps: feeBps,
      routerFee,
      poolFee: sim.poolFee,
      poolFeeRate: i.tradeFeeRate,
      total: routerFee + sim.poolFee,
    },
    priceImpactBps: impact,
    startSqrtPriceX64: poolState.sqrtPriceX64,
    endSqrtPriceX64: sim.endSqrtPriceX64,
    startTick: poolState.tickCurrent,
    endTick: sim.endTick,
    timestamp: i.timestamp,
    tickArrayStarts: sim.tickArrayStarts,
  };
  if (i.slippageBps !== undefined) {
    quote.slippageBps = i.slippageBps;
    if (exactOutput) quote.maxIn = applySlippageExactOut(amountInUsed, i.slippageBps);
    else quote.minOut = applySlippage(amountOut, i.slippageBps);
  }
  return quote;
}

// ── reads ────────────────────────────────────────────────────────────────────

export interface QuoteSwapParams {
  rpc: SolanaQuoteRpc;
  mint: Address;
  /** Exact input in base units: quote for `quoteBuySolana`, launch tokens (6dp) for `quoteSellSolana`. */
  amountIn: bigint;
  /**
   * Slippage tolerance in bps. Optional and never defaulted: with it the quote also carries
   * `minOut`; without it, call `applySlippage` yourself.
   */
  slippageBps?: number;
  /** The decoded Launch, to skip the read. */
  launch?: LaunchAccount;
  /** Cluster unix seconds the router fee is computed for. Default: read from the Clock sysvar. */
  timestamp?: bigint;
  /** Refuse a swap that crosses more tick arrays than this (a transaction can only carry so many). Default 12. */
  maxTickArrays?: number;
  chainId?: number;
  programId?: Address;
  raydiumClmm?: Address;
}

export type QuoteExactOutParams = Omit<QuoteSwapParams, "amountIn"> & { amountOut: bigint };

interface Raw {
  data: Uint8Array;
  owner: Address;
}

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function getMany(rpc: SolanaQuoteRpc, addrs: Address[]): Promise<(Raw | null)[]> {
  const out: (Raw | null)[] = [];
  // getMultipleAccounts caps at 100 keys.
  for (let i = 0; i < addrs.length; i += 100) {
    const res = await rpc.getMultipleAccounts(addrs.slice(i, i + 100), { encoding: "base64" }).send();
    for (const v of res.value) out.push(v ? { data: b64(v.data[0]), owner: v.owner } : null);
  }
  return out;
}

const AMM_CONFIG_TRADE_FEE_OFFSET = 47;
const AMM_CONFIG_MIN_LEN = 53;

async function quoteSwap(side: "buy" | "sell", p: QuoteSwapParams, exactOutput = false): Promise<SolanaSwapQuote> {
  const dep = p.chainId === undefined ? undefined : SOLANA_DEPLOYMENTS[p.chainId];
  const programId = (p.programId ?? dep?.rallySolanaProtocol ?? RALLY_SOLANA_PROTOCOL_PROGRAM_ID) as Address;
  const clmm = (p.raydiumClmm ?? dep?.raydiumClmm ?? RAYDIUM_CLMM_DEVNET) as Address;
  const launch = p.launch ?? (await fetchLaunch(p.rpc, p.mint, { programId }));
  if (launch.mint !== p.mint) {
    throw new RallyError("LAUNCH_NOT_FOUND", `The supplied Launch is for ${launch.mint}, not ${p.mint}`);
  }
  if (launch.pool === UNSET || launch.phase === "Created") {
    throw new RallyError("POOL_NOT_OPEN", `Launch ${p.mint} has no pool yet: send open_pool first.`, { details: { mint: p.mint } });
  }
  const maxArrays = p.maxTickArrays ?? 12;

  const [poolAcc, cfgAcc] = await getMany(p.rpc, [launch.pool, launch.ammConfig]);
  if (!poolAcc) throw new RallyError("POOL_NOT_OPEN", `Raydium pool ${launch.pool} does not exist`);
  if (poolAcc.owner !== clmm) throw unavailable(`Pool ${launch.pool} is owned by ${poolAcc.owner}, expected the Raydium CLMM ${clmm}`);
  if (!cfgAcc || cfgAcc.owner !== clmm || cfgAcc.data.length < AMM_CONFIG_MIN_LEN) {
    throw unavailable(`The pool's fee tier ${launch.ammConfig} cannot be read`);
  }
  const poolState = decodeClmmPool(poolAcc.data, toAddress);
  if (poolState.ammConfig !== launch.ammConfig) {
    throw new RallyError("INVALID_ACCOUNT_DATA", "The pool does not belong to the launch's fee tier");
  }
  const tradeFeeRate = BigInt(new DataView(cfgAcc.data.buffer, cfgAcc.data.byteOffset, cfgAcc.data.byteLength).getUint32(AMM_CONFIG_TRADE_FEE_OFFSET, true));

  const timestamp = p.timestamp ?? (await fetchClusterTime(p.rpc));

  // Fetch the arrays the swap will want: the first one plus the next few initialized ones in its
  // direction, then more on demand. The replay is exact, so it asks for exactly what it crosses.
  const ray = raydiumPdas(clmm);
  const zeroForOne = side === "sell";
  const loaded = new Map<number, ClmmTickArray>();
  const fetchBatch = async (starts: number[]) => {
    const todo = starts.filter((s) => !loaded.has(s));
    if (todo.length === 0) return;
    if (loaded.size + todo.length > maxArrays + 4) {
      throw unavailable(`This swap would cross more than ${maxArrays} tick arrays; split it into smaller trades`, { maxTickArrays: maxArrays });
    }
    const addrs = await Promise.all(todo.map((s) => ray.tickArray(launch.pool, s)));
    const accs = await getMany(p.rpc, addrs);
    accs.forEach((a, k) => {
      if (!a) throw unavailable(`Tick array ${addrs[k]} (start ${todo[k]}) is marked initialized by the pool but cannot be read`, { tickArray: addrs[k] });
      if (a.owner !== clmm || a.data.length !== TICK_ARRAY_ACCOUNT_LEN) {
        throw unavailable(`Tick array ${addrs[k]} is not a Raydium tick array`, { tickArray: addrs[k] });
      }
      const arr = decodeClmmTickArray(a.data, toAddress);
      if (arr.poolId !== launch.pool) throw unavailable(`Tick array ${addrs[k]} belongs to another pool`, { tickArray: addrs[k] });
      loaded.set(todo[k]!, arr);
    });
  };

  const first = firstArrayStart(poolState, zeroForOne);
  await fetchBatch([first.start, ...initializedArrayStartsAfter(poolState, first.start, zeroForOne, 2)]);

  let core: Omit<SolanaSwapQuote, "tickArrays"> | undefined;
  for (let guard = 0; guard < maxArrays + 4 && !core; guard++) {
    try {
      core = quoteSwapFromState({
        side,
        mint: p.mint,
        pool: launch.pool,
        launch,
        poolState,
        tradeFeeRate,
        getTickArray: (s) => loaded.get(s),
        amountIn: p.amountIn,
        exactOutput,
        timestamp,
        ...(p.slippageBps !== undefined ? { slippageBps: p.slippageBps } : {}),
      });
    } catch (e) {
      if (!(e instanceof TickArrayMissing)) throw e;
      await fetchBatch([e.start, ...initializedArrayStartsAfter(poolState, e.start, zeroForOne, 2)]);
    }
  }
  if (!core) throw unavailable("Could not assemble the tick arrays this swap crosses");
  if (core.tickArrayStarts.length > maxArrays) {
    throw unavailable(`This swap crosses ${core.tickArrayStarts.length} tick arrays (more than ${maxArrays}); split it into smaller trades`, {
      maxTickArrays: maxArrays,
    });
  }
  const tickArrays = await Promise.all(core.tickArrayStarts.map((s) => ray.tickArray(launch.pool, s)));
  return { ...core, tickArrays };
}

/**
 * Exact-input BUY quote: spend `amountIn` quote (router fee included) and receive `amountOut`
 * launch tokens. Replays Raydium's swap over the pool's live tick arrays and applies the router
 * fee at the cluster's current time. A point-in-time read: the price can move before the
 * transaction lands, which is what `minOut` is for. The fee only ever decays, so a later landing
 * can only improve on the quoted output, never worsen it.
 */
export const quoteBuySolana = (p: QuoteSwapParams) => quoteSwap("buy", p);

/** Exact-input SELL quote: sell `amountIn` launch tokens (6dp) for `amountOut` NET quote. */
export const quoteSellSolana = (p: QuoteSwapParams) => quoteSwap("sell", p);

/** Receive exactly amountOut tokens, quoting the total quote input including both fees. */
export const quoteBuyExactOutSolana = (p: QuoteExactOutParams) => quoteSwap("buy", { ...p, amountIn: p.amountOut }, true);
/** Receive exactly amountOut quote net of both fees. */
export const quoteSellExactOutSolana = (p: QuoteExactOutParams) => quoteSwap("sell", { ...p, amountIn: p.amountOut }, true);

// ── first buy ────────────────────────────────────────────────────────────────

// ParamKey ordinals of the program's Config table (state/config.rs).
const PARAM_TOTAL_SUPPLY = 0;
const PARAM_CURVE_ALLOCATION_BPS = 1;
const PARAM_TAIL_BPS = 2;
const PARAM_FIRST_BUY_SUPPLY_CAP_BPS = 11;

export interface QuoteFirstBuyParams {
  /** Launch tokens (6dp) the creator wants. Defaults to the launch's own `firstBuyTokens` when `launch` is given. */
  firstBuyTokens?: bigint;
  /**
   * The Launch account after `create_launch`, before `open_pool`. Its positions are the plan, so
   * nothing else is needed. Use this when the launch exists; use the fields below to quote
   * BEFORE `create_launch` (the usual case: both transactions are built up front).
   */
  launch?: LaunchAccount;
  /** Built-in curve preset 0 to 2 (default 0). For a governed preset (>= 3) pass `segments`. */
  curvePreset?: number;
  segments?: readonly CurveSegment[];
  /** `B`: the quote's `gradThreshold`. Read from `QuoteConfig` when omitted and `quoteMint` + `rpc` are given. */
  gradThreshold?: bigint;
  quoteMint?: Address;
  /** Governed parameters. Read from `Config` when omitted and `rpc` is given. */
  totalSupply?: bigint;
  curveAllocationBps?: number;
  tailBps?: number;
  /** When known, the quote also enforces the program's first-buy cap. */
  firstBuySupplyCapBps?: number;
  rpc?: SolanaRpc;
  programId?: Address;
}

export interface FirstBuyQuote extends FirstBuyPlan {
  /** Launch tokens requested. */
  firstBuyTokens: bigint;
  /** Pass this as `maxFirstBuyQuote` to `prepareOpenPool`: it is exactly what the pool takes, and the program accepts it with no slack. */
  maxFirstBuyQuote: bigint;
  tickLower: number;
  tickUpper: number;
  /** The curve the quote was computed on. */
  positions: PlannedPosition[];
  layout?: CurveLayout;
}

/**
 * What `open_pool` charges the creator for the first buy. Pure integer math over the curve the
 * program will build: no pool exists yet, so there is no state to read beyond `Config` and the
 * quote's `B`. The result is exact: `maxFirstBuyQuote = quoteCost` passes, one less reverts
 * `FirstBuySlippage`.
 */
export async function quoteFirstBuy(p: QuoteFirstBuyParams): Promise<FirstBuyQuote> {
  if (p.launch) {
    const l = p.launch;
    if (l.pool !== UNSET) throw new RallyError("UNSUPPORTED", `Launch ${l.mint} already has its pool open; the first buy is done`);
    const tokens = p.firstBuyTokens ?? l.firstBuyTokens;
    const positions = l.positions.slice(0, l.numPositions).map((x) => ({ tickLower: x.tickLower, tickUpper: x.tickUpper, liquidity: x.liquidity }));
    const plan = planFirstBuy(positions, l.tickLower, l.tickUpper, tokens);
    return { ...plan, firstBuyTokens: tokens, maxFirstBuyQuote: plan.quoteCost, tickLower: l.tickLower, tickUpper: l.tickUpper, positions };
  }

  const tokens = p.firstBuyTokens;
  if (tokens === undefined || tokens < 0n || tokens >= 1n << 64n) {
    throw new RallyError("INVALID_AMOUNT", "firstBuyTokens must be a bigint in 0..2^64-1");
  }
  const segments = p.segments ?? presetSegments(p.curvePreset ?? 0);

  let { totalSupply, curveAllocationBps, tailBps, firstBuySupplyCapBps } = p;
  if (totalSupply === undefined || curveAllocationBps === undefined || tailBps === undefined) {
    if (!p.rpc) {
      throw new RallyError(
        "MISSING_ADDRESS",
        "totalSupply, curveAllocationBps and tailBps are required without `rpc` (they are Config parameters).",
      );
    }
    const cfg = await fetchConfig(p.rpc, p.programId ? { programId: p.programId } : {});
    totalSupply ??= cfg.params[PARAM_TOTAL_SUPPLY]!;
    curveAllocationBps ??= Number(cfg.params[PARAM_CURVE_ALLOCATION_BPS]!);
    tailBps ??= Number(cfg.params[PARAM_TAIL_BPS]!);
    firstBuySupplyCapBps ??= Number(cfg.params[PARAM_FIRST_BUY_SUPPLY_CAP_BPS]!);
  }
  let b = p.gradThreshold;
  if (b === undefined) {
    if (!p.rpc || !p.quoteMint) {
      throw new RallyError("MISSING_ADDRESS", "gradThreshold is required without `rpc` and `quoteMint` (it is the quote's B).");
    }
    b = (await fetchQuoteConfig(p.rpc, p.quoteMint, p.programId ? { programId: p.programId } : {})).gradThreshold;
  }

  if (firstBuySupplyCapBps !== undefined && tokens > (totalSupply * BigInt(firstBuySupplyCapBps)) / BPS) {
    throw new RallyError("INVALID_AMOUNT", "firstBuyTokens exceeds the governed first-buy cap (FirstBuyTooLarge)", {
      details: { cap: ((totalSupply * BigInt(firstBuySupplyCapBps)) / BPS).toString() },
    });
  }
  const layout = buildCurve({ segments, totalSupply, curveAllocationBps, gradThreshold: b, tailBps });
  const plan = planFirstBuy(layout.positions, layout.tickLower, layout.tickUpper, tokens);
  return {
    ...plan,
    firstBuyTokens: tokens,
    maxFirstBuyQuote: plan.quoteCost,
    tickLower: layout.tickLower,
    tickUpper: layout.tickUpper,
    positions: layout.positions,
    layout,
  };
}
