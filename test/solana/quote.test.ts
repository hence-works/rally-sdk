import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  RallyError,
  TOKEN_PROGRAM_ADDRESS,
  applySlippage,
  fetchLaunch,
  prepareBuy,
  prepareSell,
  quoteBuySolana,
  quoteExactOutFromState,
  quoteSellSolana,
  quoteSwapFromState,
  raydiumPdas,
  routerFeeBpsAt,
} from "../../src/solana";
import { MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64, getSqrtPriceAtTick } from "../../src/solana/clmm";
import { decodeClmmPool, decodeClmmTickArray, simulateExactIn, TICK_ARRAY_ACCOUNT_LEN } from "../../src/solana/clmm-swap";
import { getAddressDecoder } from "@solana/kit";
import { MINT, accountsOf, fx, rpcFor } from "./golden/load";
import { addr, launchFixture } from "./fixtures";

const dec = getAddressDecoder();
const toAddr = (b: Uint8Array) => dec.decode(b);
const SOL = 1_000_000_000n;
const FRESH_POOL = fx.snapshots["fresh"]!.pool as Address;
const TS = 1n << 40n; // long after any decay window
const POOL_BITMAP = 904;

describe("routerFeeBpsAt: swap.rs `router_fee_bps`", () => {
  const launch = (over: object = {}) => ({
    phase: "Curve" as const,
    launchedAt: 100n,
    schedule: { curveFeeStartBps: 9900, curveFeeEndBps: 100, curveFeeDecay: 30, platformBps: 0, creatorCapBps: 0, breakoutCreatorCapBps: 0 },
    ...over,
  });
  it("decays linearly from the start rate to the end rate, in integer bps", () => {
    expect(routerFeeBpsAt(launch(), 100n)).toBe(9900n);
    expect(routerFeeBpsAt(launch(), 101n)).toBe(9900n - (9800n * 1n) / 30n);
    expect(routerFeeBpsAt(launch(), 115n)).toBe(5000n);
    expect(routerFeeBpsAt(launch(), 129n)).toBe(9900n - (9800n * 29n) / 30n);
    expect(routerFeeBpsAt(launch(), 130n)).toBe(100n);
    expect(routerFeeBpsAt(launch(), 10_000n)).toBe(100n);
  });
  it("a clock before launch counts as no time elapsed", () => {
    expect(routerFeeBpsAt(launch(), 5n)).toBe(9900n);
  });
  it("is zero off the curve, and the end rate when there is no decay or it would rise", () => {
    expect(routerFeeBpsAt(launch({ phase: "Breakout" }), 100n)).toBe(0n);
    expect(routerFeeBpsAt(launch({ phase: "Created" }), 100n)).toBe(0n);
    expect(routerFeeBpsAt(launch({ schedule: { ...launch().schedule, curveFeeDecay: 0 } }), 100n)).toBe(100n);
    expect(routerFeeBpsAt(launch({ schedule: { ...launch().schedule, curveFeeStartBps: 50 } }), 100n)).toBe(100n);
  });
});

describe("applySlippage", () => {
  it("floors, and is explicit", () => {
    expect(applySlippage(10_000n, 50)).toBe(9_950n);
    expect(applySlippage(999n, 100)).toBe(989n);
    expect(applySlippage(1_000n, 0)).toBe(1_000n);
  });
  it("rejects a non-integer, negative or >= 100% tolerance, and a bound that rounds to zero", () => {
    for (const bps of [-1, 10_000, 1.5, Number.NaN]) expect(() => applySlippage(1_000n, bps)).toThrow(RallyError);
    expect(() => applySlippage(1n, 5000)).toThrow(RallyError);
  });
});

describe("quote result shape (recorded pool, no network)", () => {
  it("a buy carries amounts, fee breakdown, impact, end price and the arrays it crosses", async () => {
    const q = await quoteBuySolana({ rpc: rpcFor("fresh"), mint: MINT, amountIn: 20n * SOL, timestamp: TS, slippageBps: 50 });
    expect(q.side).toBe("buy");
    expect(q.amountInUsed).toBe(20n * SOL);
    expect(q.fees.routerFeeBps).toBe(100n);
    expect(q.fees.routerFee).toBe(200_000_000n); // 1% of what was typed
    expect(q.fees.poolFeeRate).toBe(2500n);
    expect(q.fees.poolFee).toBeGreaterThan(0n);
    expect(q.fees.total).toBe(q.fees.routerFee + q.fees.poolFee);
    expect(q.minOut).toBe(applySlippage(q.amountOut, 50));
    expect(q.slippageBps).toBe(50);
    expect(q.endSqrtPriceX64).toBeGreaterThan(q.startSqrtPriceX64);
    expect(q.endTick).toBeGreaterThan(q.startTick);
    expect(q.priceImpactBps).toBeGreaterThan(0n);
    expect(q.tickArrays).toHaveLength(q.tickArrayStarts.length);
    expect(q.tickArrays[0]).toBe(await raydiumPdas().tickArray(FRESH_POOL, q.tickArrayStarts[0]!));
  });

  it("without slippageBps there is no minOut: slippage is never defaulted", async () => {
    const q = await quoteBuySolana({ rpc: rpcFor("fresh"), mint: MINT, amountIn: SOL, timestamp: TS });
    expect(q.minOut).toBeUndefined();
    expect(q.slippageBps).toBeUndefined();
  });

  it("a sell's fee is taken off the quote it receives and a bigger sell moves the price further", async () => {
    const small = await quoteSellSolana({ rpc: rpcFor("moved"), mint: MINT, amountIn: 10n ** 11n, timestamp: TS });
    const big = await quoteSellSolana({ rpc: rpcFor("moved"), mint: MINT, amountIn: 10n ** 13n, timestamp: TS });
    expect(small.fees.routerFee).toBe((small.amountOut + small.fees.routerFee) / 100n);
    expect(big.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    expect(big.endTick).toBeLessThan(small.endTick);
  });

  it("after breakout the router fee is zero", async () => {
    const q = await quoteBuySolana({ rpc: rpcFor("breakout"), mint: MINT, amountIn: SOL, timestamp: 1n });
    expect(q.fees.routerFeeBps).toBe(0n);
    expect(q.fees.routerFee).toBe(0n);
  });

  it("the fee at the start of the window is the start rate and decays toward the end rate", async () => {
    const launch = await fetchLaunch(rpcFor("fresh"), MINT);
    const at = (t: bigint) => quoteBuySolana({ rpc: rpcFor("fresh"), mint: MINT, amountIn: SOL, timestamp: t });
    const q0 = await at(launch.launchedAt);
    const q15 = await at(launch.launchedAt + 15n);
    const q40 = await at(launch.launchedAt + 40n);
    expect(q0.fees.routerFeeBps).toBe(9900n);
    expect(q15.fees.routerFeeBps).toBe(5000n);
    expect(q40.fees.routerFeeBps).toBe(100n);
    // A lower fee leaves more to trade, so the output only improves as time passes.
    expect(q15.amountOut).toBeGreaterThan(q0.amountOut);
    expect(q40.amountOut).toBeGreaterThan(q15.amountOut);
  });

  it("a later timestamp can only improve a buy and a sell", async () => {
    for (const run of [quoteBuySolana, quoteSellSolana]) {
      const amountIn = run === quoteBuySolana ? SOL : 10n ** 12n;
      const early = await run({ rpc: rpcFor("moved"), mint: MINT, amountIn, timestamp: 0n });
      const late = await run({ rpc: rpcFor("moved"), mint: MINT, amountIn, timestamp: TS });
      expect(late.amountOut >= early.amountOut).toBe(true);
    }
  });
});

describe("quote-token0 pools", () => {
  const mint = addr(5);
  const quoteMint = addr(1);
  const pool = addr(9);
  const launch = launchFixture({ mint, quoteMint, pool, phase: "Breakout" });
  const liquidity = 1_000_000_000_000n;
  const tickArray = {
    poolId: pool,
    startTickIndex: 0,
    ticks: Array.from({ length: 60 }, (_, i) => ({
      tick: i * 60,
      liquidityNet: i === 0 ? liquidity : 0n,
      liquidityGross: i === 0 ? liquidity : 0n,
      hasLimitOrders: false,
    })),
  };
  const poolState = {
    ammConfig: launch.ammConfig,
    mint0: quoteMint,
    mint1: mint,
    vault0: addr(10),
    vault1: addr(11),
    tickSpacing: 60,
    liquidity,
    sqrtPriceX64: getSqrtPriceAtTick(60),
    tickCurrent: 60,
    status: 0,
    feeOn: 1,
    tickArrayBitmap: 1n << 512n,
    hasDynamicFee: false,
  };
  const base = {
    side: "buy" as const,
    mint,
    pool,
    launch,
    poolState,
    tradeFeeRate: 2500n,
    getTickArray: (start: number) => start === 0 ? tickArray : undefined,
    timestamp: 1n,
  };

  it("quotes exact-input buys downward in raw Raydium coordinates while charging quote fees", () => {
    const result = quoteSwapFromState({ ...base, amountIn: 1_000_000n });
    expect(result.amountOut).toBeGreaterThan(0n);
    expect(result.fees.poolFee).toBeGreaterThan(0n);
    expect(result.endSqrtPriceX64).toBeLessThan(result.startSqrtPriceX64);
    expect(result.endTick).toBeLessThan(result.startTick);
  });

  it("quotes exact-output buys with the same reversed direction", () => {
    const result = quoteExactOutFromState({ ...base, amountOut: 100_000n });
    expect(result.exactOutput).toBe(true);
    expect(result.amountOut).toBe(100_000n);
    expect(result.endSqrtPriceX64).toBeLessThan(result.startSqrtPriceX64);
  });
});

describe("quotes refuse rather than approximate", () => {
  const ok = { mint: MINT, amountIn: 20n * SOL, timestamp: TS };

  it("a tick array the swap crosses that cannot be read", async () => {
    const rpc = rpcFor("fresh", (a) => {
      delete a[Object.keys(a).find((k) => a[k]!.data.length === TICK_ARRAY_ACCOUNT_LEN)!];
    });
    await expect(quoteBuySolana({ rpc, ...ok })).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
  });

  it("a tick array owned by someone else, or belonging to another pool", async () => {
    const wrongOwner = rpcFor("fresh", (a) => {
      for (const k of Object.keys(a)) if (a[k]!.data.length === TICK_ARRAY_ACCOUNT_LEN) a[k] = { ...a[k]!, owner: FRESH_POOL };
    });
    await expect(quoteBuySolana({ rpc: wrongOwner, ...ok })).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
    const wrongPool = rpcFor("fresh", (a) => {
      for (const k of Object.keys(a)) if (a[k]!.data.length === TICK_ARRAY_ACCOUNT_LEN) a[k]!.data.fill(7, 8, 40);
    });
    await expect(quoteBuyAny(wrongPool)).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
  });
  const quoteBuyAny = (rpc: ReturnType<typeof rpcFor>) => quoteBuySolana({ rpc, ...ok });

  it("a pool that charges a dynamic fee", async () => {
    const rpc = rpcFor("fresh", (a) => {
      a[FRESH_POOL]!.data[1096 + 4] = 1;
    });
    await expect(quoteBuySolana({ rpc, ...ok })).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
  });

  it("a swap that reaches a tick with limit orders, but not one that stops short of it", async () => {
    // The first tick above the price is the curve/tail boundary at -75360, in array -75600 (offset 4).
    const rpc = rpcFor("fresh", (a) => {
      for (const k of Object.keys(a)) {
        const d = a[k]!.data;
        if (d.length === TICK_ARRAY_ACCOUNT_LEN && new DataView(d.buffer, d.byteOffset).getInt32(40, true) === -75600) {
          new DataView(d.buffer, d.byteOffset).setBigUint64(44 + 4 * 168 + 124, 5n, true);
        }
      }
    });
    await expect(quoteBuySolana({ rpc, ...ok, amountIn: 200n * SOL })).rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
    await expect(quoteBuySolana({ rpc, ...ok, amountIn: SOL })).resolves.toBeTruthy();
  });

  it("a pool with no liquidity left in the swap's direction", async () => {
    // Drop the initialized-array bits above the price: a buy larger than the curve holds has nowhere to go.
    const rpc = rpcFor("fresh", (a) => {
      const d = a[FRESH_POOL]!.data;
      for (let i = 0; i < 16; i++) if (i * 64 > 512) d.fill(0, POOL_BITMAP + i * 8, POOL_BITMAP + i * 8 + 8);
      const dv = new DataView(d.buffer, d.byteOffset);
      dv.setBigUint64(POOL_BITMAP + 7 * 8, dv.getBigUint64(POOL_BITMAP + 7 * 8, true) & ((1n << 40n) - 1n), true);
    });
    await expect(quoteBuySolana({ rpc, ...ok, amountIn: 200n * SOL })).rejects.toMatchObject({ code: "INSUFFICIENT_LIQUIDITY" });
  });

  it("a swap that would cross more arrays than allowed", async () => {
    await expect(quoteBuySolana({ rpc: rpcFor("outside-lp"), ...ok, amountIn: 200n * SOL, maxTickArrays: 2 })).rejects.toMatchObject({
      code: "QUOTE_UNAVAILABLE",
    });
  });

  it("a launch with no pool, a foreign pool, and bad amounts", async () => {
    const launch = await fetchLaunch(rpcFor("fresh"), MINT);
    await expect(quoteBuySolana({ rpc: rpcFor("fresh"), ...ok, launch: { ...launch, phase: "Created" } })).rejects.toMatchObject({ code: "POOL_NOT_OPEN" });
    await expect(quoteBuySolana({ rpc: rpcFor("fresh"), ...ok, launch: { ...launch, quoteMint: TOKEN_PROGRAM_ADDRESS } })).rejects.toMatchObject({ code: "INVALID_ACCOUNT_DATA" });
    await expect(quoteBuySolana({ rpc: rpcFor("fresh"), ...ok, launch: { ...launch, mint: TOKEN_PROGRAM_ADDRESS } })).rejects.toMatchObject({ code: "LAUNCH_NOT_FOUND" });
    for (const amountIn of [0n, -1n, 1n << 64n]) {
      await expect(quoteBuySolana({ rpc: rpcFor("fresh"), ...ok, amountIn })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    }
  });

  it("dust the pool would round to nothing, in both directions", async () => {
    await expect(quoteBuySolana({ rpc: rpcFor("fresh"), ...ok, amountIn: 1n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(quoteSellSolana({ rpc: rpcFor("fresh"), ...ok, amountIn: 1n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });
});

describe("the replay itself", () => {
  const pool = decodeClmmPool(accountsOf("fresh")[FRESH_POOL]!.data, toAddr);
  const arrays = new Map(
    Object.values(accountsOf("fresh"))
      .filter((a) => a.data.length === TICK_ARRAY_ACCOUNT_LEN)
      .map((a) => decodeClmmTickArray(a.data, toAddr))
      .map((t) => [t.startTickIndex, t] as const),
  );
  const base = { pool, tradeFeeRate: 2500n, getTickArray: (s: number) => arrays.get(s) };

  it("a partial fill stops at the price limit and reports what it really consumed", () => {
    const limit = pool.sqrtPriceX64 + (pool.sqrtPriceX64 >> 12n);
    const r = simulateExactIn({ ...base, amountIn: 500n * SOL, zeroForOne: false, sqrtPriceLimitX64: limit });
    expect(r.endSqrtPriceX64).toBe(limit);
    expect(r.amountConsumed).toBeLessThan(500n * SOL);
    expect(r.amountOut).toBeGreaterThan(0n);
  });

  it("rejects a limit on the wrong side of the price", () => {
    expect(() => simulateExactIn({ ...base, amountIn: SOL, zeroForOne: false, sqrtPriceLimitX64: MIN_SQRT_PRICE_X64 + 1n })).toThrow(RallyError);
    expect(() => simulateExactIn({ ...base, amountIn: SOL, zeroForOne: true, sqrtPriceLimitX64: MAX_SQRT_PRICE_X64 - 1n })).toThrow(RallyError);
  });

  it("splitting a buy in two differs from one swap by rounding only, and conserves the input", () => {
    let seed = 12345n;
    const rnd = (n: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n)), seed % n);
    for (let i = 0; i < 40; i++) {
      const amt = 1_000_000n + rnd(30n * SOL);
      const whole = simulateExactIn({ ...base, amountIn: amt, zeroForOne: false, sqrtPriceLimitX64: MAX_SQRT_PRICE_X64 - 1n });
      expect(whole.amountConsumed).toBe(amt);
      const half = amt / 2n;
      const first = simulateExactIn({ ...base, amountIn: half, zeroForOne: false, sqrtPriceLimitX64: MAX_SQRT_PRICE_X64 - 1n });
      const p2 = { ...pool, sqrtPriceX64: first.endSqrtPriceX64, tickCurrent: first.endTick, liquidity: first.endLiquidity };
      const second = simulateExactIn({ ...base, pool: p2, amountIn: amt - half, zeroForOne: false, sqrtPriceLimitX64: MAX_SQRT_PRICE_X64 - 1n });
      const split = first.amountOut + second.amountOut;
      const diff = split > whole.amountOut ? split - whole.amountOut : whole.amountOut - split;
      // Each half floors its own fee-adjusted input, so the two differ by a lamport or so of quote,
      // and a lamport is worth (output / input) token units.
      expect(diff * amt <= 3n * whole.amountOut + 64n * amt).toBe(true);
    }
  });

  it("buy then sell the proceeds never returns more than was paid (fees and rounding favour the pool)", () => {
    for (const amt of [100_000n, 77_777_777n, SOL, 12n * SOL]) {
      const buy = simulateExactIn({ ...base, amountIn: amt, zeroForOne: false, sqrtPriceLimitX64: MAX_SQRT_PRICE_X64 - 1n });
      const p2 = { ...pool, sqrtPriceX64: buy.endSqrtPriceX64, tickCurrent: buy.endTick, liquidity: buy.endLiquidity };
      const sell = simulateExactIn({ ...base, pool: p2, amountIn: buy.amountOut, zeroForOne: true, sqrtPriceLimitX64: MIN_SQRT_PRICE_X64 + 1n });
      expect(sell.amountOut < amt).toBe(true);
    }
  });
});

describe("prepareBuy / prepareSell take a quote", () => {
  const trader = TOKEN_PROGRAM_ADDRESS; // any address will do for an offline build
  const common = { trader, mint: MINT, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS, deadline: 1_900_000_000n } as const;
  const dataOf = (ix: { data?: ArrayLike<number> }) => Uint8Array.from(ix.data ?? []);
  const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);
  const lastIx = (tx: { instructions: readonly { accounts?: readonly { address: Address }[]; data?: ArrayLike<number> }[] }) => tx.instructions[tx.instructions.length - 1]!;

  async function fresh(side: "buy" | "sell", amountIn: bigint) {
    const rpc = rpcFor("outside-lp");
    const launch = await fetchLaunch(rpc, MINT);
    const quote = await (side === "buy" ? quoteBuySolana : quoteSellSolana)({ rpc, mint: MINT, amountIn, timestamp: TS, launch });
    return { quote, launch };
  }

  it("derives minOut from the quote and an explicit slippage, and sends the quote's tick arrays", async () => {
    const { quote, launch } = await fresh("buy", 60n * SOL);
    const tx = await prepareBuy({ ...common, launch, quote, slippageBps: 75 });
    const ix = lastIx(tx);
    const d = dataOf(ix);
    expect(u64At(d, 8)).toBe(60n * SOL);
    expect(u64At(d, 16)).toBe(applySlippage(quote.amountOut, 75));
    const remaining = ix.accounts!.slice(23).map((a) => a.address);
    expect(remaining).toEqual([await raydiumPdas().bitmap(launch.pool), ...quote.tickArrays]);
    // The quote crosses the outside LP's arrays; the launch's own positions alone would not have listed them.
    expect(quote.tickArrays.length).toBeGreaterThan(2);
  });

  it("works for a sell too, and amountIn may be left to the quote", async () => {
    const { quote, launch } = await fresh("sell", 10n ** 12n);
    const tx = await prepareSell({ ...common, launch, quote, slippageBps: 10 });
    const d = dataOf(lastIx(tx));
    expect(u64At(d, 8)).toBe(10n ** 12n);
    expect(u64At(d, 16)).toBe(applySlippage(quote.amountOut, 10));
  });

  it("still takes an explicit minOut with a quote", async () => {
    const { quote, launch } = await fresh("buy", SOL);
    const tx = await prepareBuy({ ...common, launch, quote, minOut: 123n });
    expect(u64At(dataOf(lastIx(tx)), 16)).toBe(123n);
  });

  it("never defaults the bound: a quote alone is not enough", async () => {
    const { quote, launch } = await fresh("buy", SOL);
    await expect(prepareBuy({ ...common, launch, quote })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(prepareBuy({ ...common, launch, amountIn: SOL })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    // quote.minOut (set when the quote was taken with slippageBps) is not silently adopted either.
    const withMin = { ...quote, minOut: 5n, slippageBps: 1 };
    await expect(prepareBuy({ ...common, launch, quote: withMin })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });

  it("refuses ambiguous or inconsistent inputs", async () => {
    const { quote, launch } = await fresh("buy", SOL);
    await expect(prepareBuy({ ...common, launch, quote, slippageBps: 50, minOut: 1n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(prepareBuy({ ...common, launch, amountIn: SOL, slippageBps: 50 })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(prepareBuy({ ...common, launch, quote, slippageBps: 50, amountIn: SOL + 1n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(prepareSell({ ...common, launch, quote, slippageBps: 50 })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(prepareBuy({ ...common, mint: TOKEN_PROGRAM_ADDRESS, launch: { ...launch, mint: TOKEN_PROGRAM_ADDRESS }, quote, slippageBps: 50 })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(prepareBuy({ ...common, launch: { ...launch, pool: TOKEN_PROGRAM_ADDRESS }, quote, slippageBps: 50 })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(prepareBuy({ ...common, launch, quote, slippageBps: 10_000 })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });
});
