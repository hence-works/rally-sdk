/**
 * Off-chain replay of Raydium CLMM's exact-input `swap_internal` (Raydium @ 6d7a0f8, the
 * revision the Rally program vendors), over decoded `PoolState` and `TickArrayState` bytes.
 *
 * Scope, deliberately narrow so the replay is exact rather than approximate:
 *  - exact INPUT only (the Rally router is exact-input only);
 *  - a static fee tier. A pool with dynamic-fee state is refused: its fee depends on a
 *    volatility accumulator that moves with every tick crossed, and is not modelled;
 *  - no limit orders. A swap that REACHES a tick carrying limit-order state is refused, never skipped;
 *  - tick spacing >= 15 (Rally pins 60), where the pool's default bitmap spans every tick and
 *    Raydium never reads the bitmap extension account.
 *
 * Integer math only. Pure: no RPC.
 */

import { RallyError } from "../errors";
import {
  MAX_SQRT_PRICE_X64,
  MAX_TICK,
  MIN_SQRT_PRICE_X64,
  MIN_TICK,
  computeSwapStep,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
} from "./clmm";

export const TICK_ARRAY_SIZE = 60;
/** Bytes in a `TickArrayState` account (discriminator included). */
export const TICK_ARRAY_ACCOUNT_LEN = 10240;
/** Bytes in a `PoolState` account. */
export const POOL_STATE_ACCOUNT_LEN = 1544;

const unavailable = (message: string, details?: Record<string, unknown>) =>
  new RallyError("QUOTE_UNAVAILABLE", message, details ? { details } : undefined);

// ── decoded state ────────────────────────────────────────────────────────────

/** The `PoolState` fields a swap reads. */
export interface ClmmPoolState {
  ammConfig: string;
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  status: number;
  /** 0 = FromInput, 1 = Token0Only, 2 = Token1Only. */
  feeOn: number;
  /** The default tick-array bitmap, 1024 bits, bit `i` = array at `(i - 512) * 60 * spacing`. */
  tickArrayBitmap: bigint;
  /** True when the pool carries any dynamic-fee state. */
  hasDynamicFee: boolean;
}

export interface ClmmTick {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
  /** Limit-order state (`orders_amount` or `part_filled_orders_remaining` non-zero). */
  hasLimitOrders: boolean;
}

export interface ClmmTickArray {
  poolId: string;
  startTickIndex: number;
  ticks: ClmmTick[];
}

// Layout of Raydium `PoolState` (repr(C, packed), discriminator first). Pinned by the Rally
// program's own `PoolView` for the head and by the field order of the struct for the rest.
const POOL = {
  ammConfig: 9,
  mint0: 73,
  mint1: 105,
  vault0: 137,
  vault1: 169,
  tickSpacing: 235,
  liquidity: 237,
  sqrtPrice: 253,
  tickCurrent: 269,
  status: 389,
  feeOn: 390,
  bitmap: 904,
  dynamicFee: 1096,
  dynamicFeeLen: 80,
} as const;

const TICK = { liquidityNet: 4, liquidityGross: 20, ordersAmount: 124, partFilled: 132, size: 168 } as const;
const ARRAY = { poolId: 8, start: 40, ticks: 44 } as const;

const readU128 = (dv: DataView, o: number) => dv.getBigUint64(o, true) | (dv.getBigUint64(o + 8, true) << 64n);
const readI128 = (dv: DataView, o: number) => BigInt.asIntN(128, readU128(dv, o));

type B58 = (bytes: Uint8Array) => string;

/** Decode a `PoolState` account. `toAddress` turns 32 bytes into a base58 address. */
export function decodeClmmPool(data: Uint8Array, toAddress: B58): ClmmPoolState {
  if (data.length < POOL.dynamicFee + POOL.dynamicFeeLen) {
    throw new RallyError("INVALID_ACCOUNT_DATA", `Raydium pool account is ${data.length} bytes, too short to be a PoolState`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (o: number) => toAddress(data.subarray(o, o + 32));
  let bitmap = 0n;
  for (let i = 15; i >= 0; i--) bitmap = (bitmap << 64n) | dv.getBigUint64(POOL.bitmap + i * 8, true);
  let hasDynamicFee = false;
  for (let i = POOL.dynamicFee; i < POOL.dynamicFee + POOL.dynamicFeeLen; i++) if (data[i] !== 0) hasDynamicFee = true;
  return {
    ammConfig: key(POOL.ammConfig),
    mint0: key(POOL.mint0),
    mint1: key(POOL.mint1),
    vault0: key(POOL.vault0),
    vault1: key(POOL.vault1),
    tickSpacing: dv.getUint16(POOL.tickSpacing, true),
    liquidity: readU128(dv, POOL.liquidity),
    sqrtPriceX64: readU128(dv, POOL.sqrtPrice),
    tickCurrent: dv.getInt32(POOL.tickCurrent, true),
    status: data[POOL.status]!,
    feeOn: data[POOL.feeOn]!,
    tickArrayBitmap: bitmap,
    hasDynamicFee,
  };
}

/** Decode a `TickArrayState` account. */
export function decodeClmmTickArray(data: Uint8Array, toAddress: B58): ClmmTickArray {
  if (data.length !== TICK_ARRAY_ACCOUNT_LEN) {
    throw new RallyError("INVALID_ACCOUNT_DATA", `Raydium tick array is ${data.length} bytes, expected ${TICK_ARRAY_ACCOUNT_LEN}`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ticks: ClmmTick[] = [];
  for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
    const o = ARRAY.ticks + i * TICK.size;
    ticks.push({
      tick: dv.getInt32(o, true),
      liquidityNet: readI128(dv, o + TICK.liquidityNet),
      liquidityGross: readU128(dv, o + TICK.liquidityGross),
      hasLimitOrders:
        dv.getBigUint64(o + TICK.ordersAmount, true) > 0n || dv.getBigUint64(o + TICK.partFilled, true) > 0n,
    });
  }
  return {
    poolId: toAddress(data.subarray(ARRAY.poolId, ARRAY.poolId + 32)),
    startTickIndex: dv.getInt32(ARRAY.start, true),
    ticks,
  };
}

// ── tick-array addressing and the bitmap ─────────────────────────────────────

/** Start tick of the array holding `tick` (Raydium `get_array_start_index`). */
export function tickArrayStartIndex(tick: number, spacing: number): number {
  const n = TICK_ARRAY_SIZE * spacing;
  let start = Math.trunc(tick / n);
  if (tick < 0 && tick % n !== 0) start -= 1;
  return start * n;
}

const bitSet = (bitmap: bigint, pos: number) => ((bitmap >> BigInt(pos)) & 1n) === 1n;

/** Raydium `check_current_tick_array_is_initialized`. */
function currentArrayInitialized(bitmap: bigint, tickCurrent: number, spacing: number): { initialized: boolean; start: number } {
  const mult = spacing * TICK_ARRAY_SIZE;
  let compressed = Math.trunc(tickCurrent / mult) + 512;
  if (tickCurrent < 0 && tickCurrent % mult !== 0) compressed -= 1;
  return { initialized: bitSet(bitmap, Math.abs(compressed)), start: (compressed - 512) * mult };
}

/**
 * Raydium `next_initialized_tick_array_start_index` on the pool's default bitmap, spacing >= 15
 * (where a miss means the direction is exhausted). `null` when none is left.
 */
export function nextInitializedArrayStart(
  bitmap: bigint,
  lastStart: number,
  spacing: number,
  zeroForOne: boolean,
): number | null {
  const mult = spacing * TICK_ARRAY_SIZE;
  const boundary = spacing * TICK_ARRAY_SIZE * 512;
  const next = zeroForOne ? lastStart - mult : lastStart + mult;
  if (next < -boundary || next >= boundary) return null;
  const pos = Math.abs(Math.trunc(next / mult) + 512);
  if (zeroForOne) {
    // Highest set bit at or below pos.
    const masked = bitmap & ((1n << BigInt(pos + 1)) - 1n);
    if (masked === 0n) return null;
    return (masked.toString(2).length - 1 - 512) * mult;
  }
  // Lowest set bit at or above pos.
  const shifted = bitmap >> BigInt(pos);
  if (shifted === 0n) return null;
  const low = (shifted & -shifted).toString(2).length - 1;
  return (pos + low - 512) * mult;
}

/**
 * The start indices of the next `count` initialized tick arrays from `fromStart` (exclusive),
 * in swap direction. Used to batch the account reads a swap is likely to need.
 */
export function initializedArrayStartsAfter(
  pool: Pick<ClmmPoolState, "tickArrayBitmap" | "tickSpacing">,
  fromStart: number,
  zeroForOne: boolean,
  count: number,
): number[] {
  const out: number[] = [];
  let cursor = fromStart;
  while (out.length < count) {
    const n = nextInitializedArrayStart(pool.tickArrayBitmap, cursor, pool.tickSpacing, zeroForOne);
    if (n === null) break;
    out.push(n);
    cursor = n;
  }
  return out;
}

/** The first array the swap loads: the pool's current array if initialized, else the next one in direction. */
export function firstArrayStart(pool: ClmmPoolState, zeroForOne: boolean): { start: number; containsPoolTick: boolean } {
  const cur = currentArrayInitialized(pool.tickArrayBitmap, pool.tickCurrent, pool.tickSpacing);
  if (cur.initialized) return { start: cur.start, containsPoolTick: true };
  const next = nextInitializedArrayStart(pool.tickArrayBitmap, tickArrayStartIndex(pool.tickCurrent, pool.tickSpacing), pool.tickSpacing, zeroForOne);
  if (next === null) {
    throw new RallyError("INSUFFICIENT_LIQUIDITY", "The pool has no initialized liquidity in the swap's direction");
  }
  return { start: next, containsPoolTick: false };
}

// ── the swap ─────────────────────────────────────────────────────────────────

/** Thrown by the replay when it needs a tick array the caller has not supplied. */
export class TickArrayMissing extends Error {
  constructor(readonly start: number) {
    super(`tick array ${start} is not loaded`);
  }
}

export interface SwapSimInput {
  pool: ClmmPoolState;
  /** `trade_fee_rate` of the pool's `AmmConfig`, over 1_000_000. */
  tradeFeeRate: bigint;
  /** Resolve a tick array by start index; `undefined` = not loaded (the replay throws `TickArrayMissing`). */
  getTickArray: (start: number) => ClmmTickArray | undefined;
  amountIn: bigint;
  zeroForOne: boolean;
  /** Raydium's `sqrt_price_limit_x64`. The Rally router passes `MIN + 1` (sell) / `MAX - 1` (buy). */
  sqrtPriceLimitX64: bigint;
}

export interface SwapSimResult {
  /** Input the pool took (fee included for a fee-on-input swap). Less than `amountIn` only on a partial fill. */
  amountConsumed: bigint;
  /** Output the taker receives (net of any fee-on-output). */
  amountOut: bigint;
  /** Pool fee, in the quote (token_1). */
  poolFee: bigint;
  endSqrtPriceX64: bigint;
  endTick: number;
  endLiquidity: bigint;
  /** Tick arrays the swap loaded, in the order the program must receive them. */
  tickArrayStarts: number[];
}

/** Replay `swap_internal` (exact input, static fee, no limit orders). */
export function simulateExactIn(input: SwapSimInput): SwapSimResult {
  const { pool, tradeFeeRate, zeroForOne, sqrtPriceLimitX64 } = input;
  const spacing = pool.tickSpacing;
  if (input.amountIn <= 0n) throw new RallyError("INVALID_AMOUNT", "amountIn must be positive");
  if (spacing < 15) throw unavailable(`Tick spacing ${spacing} is not supported by the quote math (Rally pools use 60)`);
  if (pool.hasDynamicFee) throw unavailable("This pool charges a dynamic fee; the quote math does not model it, so it will not guess");
  // Raydium PoolStatusBitIndex::Swap = bit 4: set means swap disabled.
  if ((pool.status & 0b1_0000) !== 0) throw new RallyError("UNSUPPORTED", "Swaps are disabled on this pool");
  if (pool.feeOn > 2) throw unavailable(`Unknown collect_fee_on ${pool.feeOn}`);
  const limitOk = zeroForOne
    ? sqrtPriceLimitX64 < pool.sqrtPriceX64 && sqrtPriceLimitX64 > MIN_SQRT_PRICE_X64
    : sqrtPriceLimitX64 > pool.sqrtPriceX64 && sqrtPriceLimitX64 < MAX_SQRT_PRICE_X64;
  if (!limitOk) throw new RallyError("INVALID_AMOUNT", "sqrt price limit is on the wrong side of the pool price");

  // collect_fee_on: 0 FromInput, 1 Token0Only, 2 Token1Only.
  const feeOnInput = pool.feeOn === 0 ? true : pool.feeOn === 1 ? zeroForOne : !zeroForOne;

  const loaded = (start: number): ClmmTickArray => {
    const a = input.getTickArray(start);
    if (!a) throw new TickArrayMissing(start);
    if (a.startTickIndex !== start) {
      throw new RallyError("INVALID_ACCOUNT_DATA", `Tick array at ${start} reports start index ${a.startTickIndex}`);
    }
    return a;
  };
  const initialized = (t: ClmmTick) => t.liquidityGross > 0n || t.hasLimitOrders;

  const first = firstArrayStart(pool, zeroForOne);
  let containsPoolTick = first.containsPoolTick;
  let validStart = first.start;
  let current = loaded(validStart);
  const visited = [validStart];

  let remaining = input.amountIn;
  let calculated = 0n;
  let poolFee = 0n;
  let sqrt = pool.sqrtPriceX64;
  let tick = pool.tickCurrent;
  let liquidity = pool.liquidity;

  const nextInArray = (arr: ClmmTickArray): ClmmTick | null => {
    if (tickArrayStartIndex(tick, spacing) !== arr.startTickIndex) return null;
    const offset = Math.floor((tick - arr.startTickIndex) / spacing);
    if (zeroForOne) {
      for (let i = offset; i >= 0; i--) if (initialized(arr.ticks[i]!)) return arr.ticks[i]!;
    } else {
      for (let i = offset + 1; i < TICK_ARRAY_SIZE; i++) if (initialized(arr.ticks[i]!)) return arr.ticks[i]!;
    }
    return null;
  };
  const firstInArray = (arr: ClmmTickArray): ClmmTick => {
    const order = zeroForOne ? [...arr.ticks].reverse() : arr.ticks;
    const t = order.find(initialized);
    if (!t) throw new RallyError("INVALID_ACCOUNT_DATA", `Tick array ${arr.startTickIndex} is marked initialized but holds no tick`);
    return t;
  };

  while (remaining !== 0n && sqrt !== sqrtPriceLimitX64) {
    let nextTick = nextInArray(current);
    if (!nextTick) {
      if (!containsPoolTick) {
        containsPoolTick = true;
        nextTick = firstInArray(current);
      } else {
        const nextStart = nextInitializedArrayStart(pool.tickArrayBitmap, validStart, spacing, zeroForOne);
        if (nextStart === null) {
          throw new RallyError(
            "INSUFFICIENT_LIQUIDITY",
            "The pool runs out of liquidity before this input is filled; the program would revert the swap",
          );
        }
        current = loaded(nextStart);
        validStart = nextStart;
        visited.push(nextStart);
        nextTick = firstInArray(current);
      }
    }
    const tickNext = Math.min(Math.max(nextTick.tick, MIN_TICK), MAX_TICK);
    const sqrtNext = getSqrtPriceAtTick(tickNext);
    const target = zeroForOne
      ? sqrtNext < sqrtPriceLimitX64
        ? sqrtPriceLimitX64
        : sqrtNext
      : sqrtNext > sqrtPriceLimitX64
        ? sqrtPriceLimitX64
        : sqrtNext;
    if (zeroForOne ? !(tick >= tickNext && sqrt >= sqrtNext && sqrt >= target) : !(tickNext > tick && sqrtNext >= sqrt && target >= sqrt)) {
      throw new RallyError("INVALID_ACCOUNT_DATA", "Tick array order is inconsistent with the pool price");
    }

    // Static fee: the inner loop of `swap_internal` runs one pass per initialized tick.
    let liquidityNext = liquidity;
    const priceChange = sqrt !== target;
    let stepSqrtNext = target;
    if (priceChange) {
      const step = computeSwapStep(sqrt, target, liquidity, remaining, tradeFeeRate, zeroForOne, feeOnInput);
      remaining -= feeOnInput ? step.amountIn + step.feeAmount : step.amountIn;
      if (remaining < 0n) throw new RallyError("INVALID_AMOUNT", "swap step consumed more than the input");
      calculated += step.amountOut;
      poolFee += step.feeAmount;
      stepSqrtNext = step.sqrtPriceNextX64;
    }

    if (sqrtNext === stepSqrtNext) {
      // Reached the next initialized tick: cross it. Limit orders resting on it would be matched
      // here by the pool; that is not modelled, so a swap that REACHES one is refused (a swap that
      // stops short of it is unaffected by it, and quoted exactly).
      if (nextTick.hasLimitOrders) {
        throw unavailable(`Tick ${nextTick.tick} holds limit orders; the quote math does not model them, so it will not guess`, {
          tick: nextTick.tick,
        });
      }
      if (nextTick.liquidityGross > 0n) {
        const net = zeroForOne ? -nextTick.liquidityNet : nextTick.liquidityNet;
        liquidityNext = liquidity + net;
        if (liquidityNext < 0n) throw new RallyError("INVALID_ACCOUNT_DATA", "Crossing a tick would make liquidity negative");
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrt !== stepSqrtNext) {
      tick = getTickAtSqrtPrice(stepSqrtNext);
    }
    sqrt = stepSqrtNext;
    liquidity = liquidityNext;
  }

  const consumed = input.amountIn - remaining;
  if (consumed === 0n || calculated === 0n) {
    throw new RallyError("INVALID_AMOUNT", "Amount is too small: the pool would round the fill to zero (TooSmallInputOrOutputAmount)");
  }
  return {
    amountConsumed: consumed,
    amountOut: calculated,
    poolFee,
    endSqrtPriceX64: sqrt,
    endTick: tick,
    endLiquidity: liquidity,
    tickArrayStarts: visited,
  };
}
