/**
 * Raydium CLMM math in bigint, ported line for line from the Rust the Rally program vendors
 * (`packages/rally-solana/programs/rally-solana-protocol/src/math/*.rs`, itself Raydium CLMM
 * @ 6d7a0f8) and from Raydium's own `swap_math`, `sqrt_price_math`, `liquidity_math` and
 * `swap_internal`. Nothing here is "close to" the pool: every rounding direction is the
 * pool's, because a quote that is one unit off would be an unfillable `minOut`.
 *
 * Integer math only. Pure: no RPC, no `@solana/kit`.
 */

import { RallyError } from "../errors";

export const Q64 = 1n << 64n;
export const Q128 = 1n << 128n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MIN_SQRT_PRICE_X64 = 4295048016n;
export const MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;

/** Raydium's fee denominator: a `trade_fee_rate` of 2500 is 0.25%. */
export const FEE_RATE_DENOMINATOR = 1_000_000n;

/** Raydium's `MaxTokenOverflow`: an amount over u64 (inside a swap step it means "target not reachable"). */
class MaxTokenOverflow extends RallyError {
  constructor() {
    super("INVALID_AMOUNT", "amount exceeds u64");
  }
}

const fail = (code: ConstructorParameters<typeof RallyError>[0], message: string, details?: Record<string, unknown>) =>
  new RallyError(code, message, details ? { details } : undefined);

// ── tick <-> sqrt price ──────────────────────────────────────────────────────

// Magic factors of Raydium `get_sqrt_price_at_tick`, bit i of |tick|.
const TICK_FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d4000n],
  [0x4, 0xfff2e50f5f657000n],
  [0x8, 0xffe5caca7e10f000n],
  [0x10, 0xffcb9843d60f7000n],
  [0x20, 0xff973b41fa98e800n],
  [0x40, 0xff2ea16466c9b000n],
  [0x80, 0xfe5dee046a9a3800n],
  [0x100, 0xfcbe86c7900bb000n],
  [0x200, 0xf987a7253ac65800n],
  [0x400, 0xf3392b0822bb6000n],
  [0x800, 0xe7159475a2caf000n],
  [0x1000, 0xd097f3bdfd2f2000n],
  [0x2000, 0xa9f746462d9f8000n],
  [0x4000, 0x70d869a156f31c00n],
  [0x8000, 0x31be135f97ed3200n],
  [0x10000, 0x9aa508b5b85a500n],
  [0x20000, 0x5d6af8dedc582cn],
  [0x40000, 0x2216e584f5fan],
];

/** `1.0001^(tick/2)` as Q64.64. Throws when `|tick| > MAX_TICK`. */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw fail("INVALID_AMOUNT", `tick ${tick} is out of range`, { tick });
  }
  const abs = Math.abs(tick);
  let ratio = abs & 0x1 ? 0xfffcb933bd6fb800n : Q64;
  for (const [bit, factor] of TICK_FACTORS) {
    if (abs & bit) ratio = (ratio * factor) >> 64n;
  }
  if (tick > 0) ratio = U128_MAX / ratio;
  return ratio;
}

const BIT_PRECISION = 16;

/** The greatest tick whose sqrt price is <= `sqrtPriceX64` (Raydium `get_tick_at_sqrt_price`). */
export function getTickAtSqrtPrice(sqrtPriceX64: bigint): number {
  if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 >= MAX_SQRT_PRICE_X64) {
    throw fail("INVALID_AMOUNT", "sqrtPriceX64 is out of range", { sqrtPriceX64: sqrtPriceX64.toString() });
  }
  const msb = BigInt(sqrtPriceX64.toString(2).length - 1);
  const log2pIntegerX32 = (msb - 64n) << 32n;
  let bit = 0x8000_0000_0000_0000n;
  let log2pFractionX64 = 0n;
  let r = msb >= 64n ? sqrtPriceX64 >> (msb - 63n) : sqrtPriceX64 << (63n - msb);
  for (let precision = 0; bit > 0n && precision < BIT_PRECISION; precision++) {
    r = r * r;
    const moreThanTwo = r >> 127n;
    r >>= 63n + moreThanTwo;
    log2pFractionX64 += bit * moreThanTwo;
    bit >>= 1n;
  }
  const log2pX32 = log2pIntegerX32 + (log2pFractionX64 >> 32n);
  const logSqrt10001X64 = log2pX32 * 59543866431248n;
  // BigInt `>>` is an arithmetic shift, the same as Rust's on i128.
  const tickLow = Number((logSqrt10001X64 - 184467440737095516n) >> 64n);
  const tickHigh = Number((logSqrt10001X64 + 15793534762490258745n) >> 64n);
  if (tickLow === tickHigh) return tickLow;
  return getSqrtPriceAtTick(tickHigh) <= sqrtPriceX64 ? tickHigh : tickLow;
}

// ── amounts over a price range ───────────────────────────────────────────────

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

function order(a: bigint, b: bigint): [bigint, bigint] {
  return a > b ? [b, a] : [a, b];
}

/** `Δx = L·Q64·(√Pb − √Pa) / (√Pa·√Pb)`; throws when over u64. */
export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = order(sqrtA, sqrtB);
  if (a <= 0n) throw fail("INVALID_ACCOUNT_DATA", "zero sqrt price");
  const num = (liquidity << 64n) * (b - a);
  const den = a * b;
  const r = roundUp ? ceilDiv(num, den) : num / den;
  if (r > U64_MAX) throw new MaxTokenOverflow();
  return r;
}

/** `Δy = L·(√Pb − √Pa) / Q64`. */
export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = order(sqrtA, sqrtB);
  const num = liquidity * (b - a);
  const r = roundUp ? ceilDiv(num, Q64) : num / Q64;
  if (r > U64_MAX) throw new MaxTokenOverflow();
  return r;
}


/** Most liquidity from `amount0` over `[a, b)`, rounded down (Raydium two-step form). */
export function liquidityFromAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (amount0 === 0n) return 0n;
  const [a, b] = order(sqrtA, sqrtB);
  if (b <= a) throw fail("INVALID_AMOUNT", "empty price range");
  const intermediate = (a * b) / Q64;
  return (amount0 * intermediate) / (b - a);
}

/** Most liquidity from `amount1` over `[a, b)`, rounded down. */
export function liquidityFromAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (amount1 === 0n) return 0n;
  const [a, b] = order(sqrtA, sqrtB);
  if (b <= a) throw fail("INVALID_AMOUNT", "empty price range");
  return (amount1 * Q64) / (b - a);
}

/**
 * The token amounts a position `[lo, hi)` of `liquidity` holds at `sqrtP`, rounded the way the
 * pool rounds a DEPOSIT (`roundUp`) or a WITHDRAWAL (down).
 */
export function amountsForLiquidity(
  sqrtP: bigint,
  sqrtLo: bigint,
  sqrtHi: bigint,
  liquidity: bigint,
  roundUp: boolean,
): { amount0: bigint; amount1: bigint } {
  if (sqrtP <= sqrtLo) return { amount0: amount0Delta(sqrtLo, sqrtHi, liquidity, roundUp), amount1: 0n };
  if (sqrtP < sqrtHi) {
    return {
      amount0: amount0Delta(sqrtP, sqrtHi, liquidity, roundUp),
      amount1: amount1Delta(sqrtLo, sqrtP, liquidity, roundUp),
    };
  }
  return { amount0: 0n, amount1: amount1Delta(sqrtLo, sqrtHi, liquidity, roundUp) };
}

// ── next sqrt price ──────────────────────────────────────────────────────────

/** `√P' = √P·L / (L + Δx·√P)`, rounded up (Raydium `get_next_sqrt_price_from_amount_0_rounding_up`, add). */
function nextSqrtFromAmount0AddRoundingUp(sqrt: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrt;
  const numerator1 = liquidity << 64n;
  const denominator = numerator1 + amount * sqrt;
  return ceilDiv(numerator1 * sqrt, denominator);
}

/** `√P' = √P + Δy / L`, rounded down (add). */
function nextSqrtFromAmount1AddRoundingDown(sqrt: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrt;
  const r = sqrt + (amount << 64n) / liquidity;
  if (r > U128_MAX) throw fail("INVALID_AMOUNT", "sqrt price overflow");
  return r;
}

/** Raydium `get_next_sqrt_price_from_input`. */
export function nextSqrtPriceFromInput(sqrt: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrt < MIN_SQRT_PRICE_X64 || sqrt >= MAX_SQRT_PRICE_X64) throw fail("INVALID_AMOUNT", "sqrt price out of range");
  if (liquidity <= 0n) throw fail("INSUFFICIENT_LIQUIDITY", "zero liquidity in range");
  return zeroForOne
    ? nextSqrtFromAmount0AddRoundingUp(sqrt, liquidity, amountIn)
    : nextSqrtFromAmount1AddRoundingDown(sqrt, liquidity, amountIn);
}

/** Raydium `get_next_sqrt_price_from_output`, rounded toward sufficient input. */
export function nextSqrtPriceFromOutput(sqrt: bigint, liquidity: bigint, amountOut: bigint, zeroForOne: boolean): bigint {
  if (liquidity <= 0n) throw fail("INSUFFICIENT_LIQUIDITY", "zero liquidity in range");
  const numerator = liquidity << 64n;
  if (zeroForOne) {
    const delta = ceilDiv(amountOut << 64n, liquidity);
    if (delta >= sqrt) throw fail("INSUFFICIENT_LIQUIDITY", "output exhausts liquidity");
    return sqrt - delta;
  }
  const denominator = numerator - amountOut * sqrt;
  if (denominator <= 0n) throw fail("INSUFFICIENT_LIQUIDITY", "output exhausts liquidity");
  const next = ceilDiv(numerator * sqrt, denominator);
  if (next > U128_MAX) throw fail("INVALID_AMOUNT", "sqrt price overflow");
  return next;
}

/**
 * Raydium `get_delta_amounts_for_swap`: `(amountIn, amountOut)` between two prices, input
 * rounded up and output down. `null` when either exceeds u64 (Raydium's `MaxTokenOverflow`).
 */
function deltaAmountsForSwap(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  zeroForOne: boolean,
): { amountIn: bigint; amountOut: bigint } | null {
  const [a, b] = order(sqrtA, sqrtB);
  if (a <= 0n) throw fail("INVALID_ACCOUNT_DATA", "zero sqrt price");
  const amount1X64 = liquidity * (b - a);
  const product = a * b;
  let amountIn: bigint;
  let amountOut: bigint;
  if (zeroForOne) {
    amountIn = ceilDiv(amount1X64 << 64n, product);
    amountOut = amount1X64 >> 64n;
  } else {
    amountIn = (amount1X64 + U64_MAX) >> 64n;
    amountOut = (amount1X64 << 64n) / product;
  }
  if (amountIn > U64_MAX || amountOut > U64_MAX) return null;
  return { amountIn, amountOut };
}

// ── one swap step ────────────────────────────────────────────────────────────

export interface SwapStep {
  sqrtPriceNextX64: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/**
 * Raydium `compute_swap` for an exact-input or exact-output step.
 * `feeOnInput` is derived from Raydium's `collect_fee_on` side and swap direction. Rally selects
 * the canonical side holding quote, so a buy pays the pool fee on quote input and a sell pays it
 * on quote output.
 */
export function computeSwapStep(
  sqrtCurrent: bigint,
  sqrtTarget: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feeRate: bigint,
  zeroForOne: boolean,
  feeOnInput: boolean,
  exactInput = true,
): SwapStep {
  if (feeRate < 0n || feeRate >= FEE_RATE_DENOMINATOR) throw fail("INVALID_AMOUNT", "invalid pool fee rate");
  const amountForPriceCalc = exactInput
    ? (feeOnInput ? (amountRemaining * (FEE_RATE_DENOMINATOR - feeRate)) / FEE_RATE_DENOMINATOR : amountRemaining)
    : (feeOnInput ? amountRemaining : ceilDiv(amountRemaining * FEE_RATE_DENOMINATOR, FEE_RATE_DENOMINATOR - feeRate));
  if (amountForPriceCalc > U64_MAX) throw fail("INVALID_AMOUNT", "gross output exceeds u64");

  const atTarget = deltaAmountsForSwap(sqrtTarget, sqrtCurrent, liquidity, zeroForOne);
  const reachable = atTarget !== null && amountForPriceCalc >= (exactInput ? atTarget.amountIn : atTarget.amountOut);

  let sqrtNext: bigint;
  let amountIn: bigint;
  let amountOut: bigint;
  if (reachable) {
    sqrtNext = sqrtTarget;
    amountIn = atTarget!.amountIn;
    amountOut = atTarget!.amountOut;
  } else {
    sqrtNext = (exactInput ? nextSqrtPriceFromInput : nextSqrtPriceFromOutput)(sqrtCurrent, liquidity, amountForPriceCalc, zeroForOne);
    const d = deltaAmountsForSwap(sqrtNext, sqrtCurrent, liquidity, zeroForOne);
    if (!d) throw fail("INVALID_AMOUNT", "swap step amount exceeds u64");
    amountIn = d.amountIn;
    amountOut = d.amountOut;
  }
  if (zeroForOne ? sqrtNext < sqrtTarget : sqrtNext > sqrtTarget) {
    throw fail("INVALID_AMOUNT", "swap step overshot its target price");
  }

  let feeAmount: bigint;
  if (!exactInput) {
    if (feeOnInput) {
      amountOut = amountOut < amountRemaining ? amountOut : amountRemaining;
      feeAmount = ceilDiv(amountIn * feeRate, FEE_RATE_DENOMINATOR - feeRate);
    } else {
      feeAmount = ceilDiv(amountOut * feeRate, FEE_RATE_DENOMINATOR);
      const net = amountOut - feeAmount;
      if (net > amountRemaining) {
        feeAmount = amountOut - amountRemaining;
        amountOut = amountRemaining;
      } else amountOut = net;
    }
  } else if (feeOnInput) {
    feeAmount =
      sqrtNext !== sqrtTarget
        ? amountRemaining - amountIn
        : ceilDiv(amountIn * feeRate, FEE_RATE_DENOMINATOR - feeRate);
  } else {
    // Fee from the gross output, ceil; the taker keeps the rest.
    feeAmount = ceilDiv(amountOut * feeRate, FEE_RATE_DENOMINATOR);
    amountOut -= feeAmount;
    // A partial step charges the whole remaining input (the sub-unit excess goes to the pool).
    if (sqrtNext !== sqrtTarget) amountIn = amountRemaining;
  }
  return { sqrtPriceNextX64: sqrtNext, amountIn, amountOut, feeAmount };
}
