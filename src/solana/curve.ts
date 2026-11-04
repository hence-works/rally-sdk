/**
 * The Rally Solana curve in bigint, ported from `math/curve.rs` and `state/presets.rs` of the
 * program (`packages/rally-solana`). It exists so a client can know, BEFORE `create_launch` has
 * landed, exactly what `open_pool` will charge for the creator's first buy.
 *
 * Integer math only. Every rounding step is the program's: the first-buy quote is compared
 * against a program bound that is exact, so being one unit low would revert the pool opening.
 */

import { RallyError } from "../errors";
import {
  MAX_TICK,
  Q64,
  U64_MAX,
  U128_MAX,
  amount0Delta,
  amount1Delta,
  amountsForLiquidity,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  liquidityFromAmount0,
  liquidityFromAmount1,
} from "./clmm";
import type { CurveSegment } from "./types";

export const BPS = 10_000n;
/** Every launch pool uses a Raydium tier with this spacing. */
export const CURVE_TICK_SPACING = 60;
const MAX_SEGMENTS = 4;
const MAX_CURVE_POSITIONS = 5;
const MAX_POSITIONS = MAX_CURVE_POSITIONS + 1;
const CURVE_SUPPLY_BAND_BPS = 2_500n;
const MIN_OPENING_DEPTH_BPS = 5_000n;
const MAX_OPENING_DEPTH_BPS = 20_000n;

const bad = (message: string) => new RallyError("INVALID_AMOUNT", message);

/** A concentrated position the launch owns, as the program plans it. */
export interface PlannedPosition {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/** What `create_launch` derives about a curve. */
export interface CurveLayout {
  tickLower: number;
  tickUpper: number;
  curveSupply: bigint;
  tailSupply: bigint;
  /** Curve positions first, the tail last (when it has liquidity). */
  positions: PlannedPosition[];
}

const seg = (startBps: number, endBps: number, numPositions: number, sharesBps: number, anchorAtFar: boolean): CurveSegment => ({
  startBps,
  endBps,
  numPositions,
  sharesBps,
  anchorAtFar,
});

/** The built-in shapes (program `presets.rs`): 0 flat, 1 wall, 2 floor. Governed presets (>= 3) are not built in. */
export function presetSegments(id: number): CurveSegment[] {
  switch (id) {
    case 0:
      return [seg(0, 10_000, 1, 10_000, true)];
    case 1:
      return [seg(0, 5_000, 1, 7_916, true), seg(5_000, 10_000, 4, 2_084, true)];
    case 2:
      return [seg(0, 5_000, 4, 6_516, false), seg(5_000, 10_000, 1, 3_484, true)];
    default:
      throw new RallyError(
        "UNSUPPORTED",
        `Curve preset ${id} is not built in. Pass its segments (a governed preset lives in an account on chain).`,
      );
  }
}

/** Round a tick down (`down`) or up to the spacing grid. */
export function alignTick(down: boolean, tick: number, spacing: number): number {
  const d = Math.floor(tick / spacing) * spacing;
  if (down) return d;
  return d === tick ? d : d + spacing;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** `[tick(P(0)), tick(P(B))]` on the spacing grid, from `(S, S_c, B)`. */
export function curveTicks(totalSupply: bigint, curveAlloc: bigint, b: bigint, spacing: number): [number, number] {
  if (!(curveAlloc > 0n && curveAlloc < totalSupply && b > 0n)) throw bad("Bad curve parameters");
  const sc = curveAlloc;
  const xv = (b * (totalSupply - sc)) / sc;
  if (xv <= 0n) throw bad("Bad curve parameters");
  const k = (sc * xv * (xv + b)) / b;
  if (k > U128_MAX) throw bad("Curve parameters overflow");
  const l = isqrt(k);
  if (l <= 0n) throw bad("Bad curve parameters");
  const sqrtStart = (xv * Q64) / l;
  const sqrtEnd = ((xv + b) * Q64) / l;
  const lower = alignTick(true, getTickAtSqrtPrice(sqrtStart), spacing);
  const upper = alignTick(false, getTickAtSqrtPrice(sqrtEnd), spacing);
  if (!(lower < upper)) throw bad("Bad curve parameters");
  return [lower, upper];
}

function validateSegments(segments: readonly CurveSegment[]): void {
  const n = segments.length;
  if (!(n > 0 && n <= MAX_SEGMENTS)) throw bad("Bad curve shape: 1 to 4 segments");
  let shares = 0;
  let prevStart = 0;
  let covered = 0;
  let positions = 0;
  segments.forEach((s, i) => {
    if (!(s.startBps < s.endBps && s.endBps <= 10_000)) throw bad("Bad curve shape: segment bounds");
    if (!(i === 0 || s.startBps >= prevStart)) throw bad("Bad curve shape: segments out of order");
    if (!(s.startBps <= covered)) throw bad("Bad curve shape: gap between segments");
    if (!(s.numPositions > 0 && s.sharesBps > 0)) throw bad("Bad curve shape: empty segment");
    prevStart = s.startBps;
    covered = Math.max(covered, s.endBps);
    shares += s.sharesBps;
    positions += s.numPositions;
  });
  if (!(segments[0]!.startBps === 0 && covered === 10_000)) throw bad("Bad curve shape: must span 0..10000 bps");
  if (shares !== 10_000) throw bad("Bad curve shape: shares must sum to 10000 bps");
  if (positions > MAX_CURVE_POSITIONS) throw bad("Bad curve shape: too many positions");
}

interface Curve {
  lo: number;
  hi: number;
  numPositions: number;
  anchorAtFar: boolean;
  sharesBps: number;
}

function edge(bps: number, lower: number, upper: number, spacing: number): number {
  if (bps === 0) return lower;
  if (bps === 10_000) return upper;
  const span = upper - lower;
  return alignTick(true, lower + Math.trunc((span * bps) / 10_000), spacing);
}

function expand(segments: readonly CurveSegment[], lower: number, upper: number, spacing: number): Curve[] {
  return segments.map((s) => {
    const lo = edge(s.startBps, lower, upper, spacing);
    const hi = edge(s.endBps, lower, upper, spacing);
    if (!(lo < hi)) throw bad("Bad curve shape: segment collapses on the tick grid");
    return { lo, hi, numPositions: s.numPositions, anchorAtFar: s.anchorAtFar, sharesBps: s.sharesBps };
  });
}

function nestTicks(c: Curve, spacing: number): { anchor: number; moving: number[] } {
  const spread = c.hi - c.lo;
  const [anchor, start, towardUpper] = c.anchorAtFar ? [c.hi, c.lo, true] : [c.lo, c.hi, false];
  const n = c.numPositions;
  const moving: number[] = [];
  for (let i = 0; i < n; i++) {
    const step = Math.trunc((i * spread) / n);
    const raw = towardUpper ? start + step : start - step;
    const t = alignTick(towardUpper, raw, spacing);
    if (t === anchor) continue;
    moving.push(t);
  }
  return { anchor, moving };
}

function calibrate(curves: readonly Curve[], spacing: number, b: bigint): bigint {
  let gmWeighted = 0n;
  for (const c of curves) {
    const { anchor, moving } = nestTicks(c, spacing);
    if (moving.length === 0) throw bad("Bad curve shape: nothing to place");
    const sa = getSqrtPriceAtTick(anchor);
    let acc = 0n;
    for (const t of moving) acc += (sa * getSqrtPriceAtTick(t)) / Q64;
    gmWeighted += (acc * BigInt(c.sharesBps)) / BigInt(moving.length);
  }
  if (gmWeighted === 0n) throw bad("Bad curve shape");
  const s = (b * Q64 * BPS) / gmWeighted;
  if (s > U64_MAX) throw bad("Curve supply overflows u64");
  return s;
}

/** Liquidity covering `tick`. */
export function depthAt(positions: readonly PlannedPosition[], tick: number): bigint {
  let d = 0n;
  for (const p of positions) if (tick >= p.tickLower && tick < p.tickUpper) d += p.liquidity;
  return d;
}

export interface BuildCurveParams {
  segments: readonly CurveSegment[];
  /** `S`, launch-token base units (Config `TotalSupply`). */
  totalSupply: bigint;
  /** `S_c` as bps of `S` (Config `CurveAllocationBps`). */
  curveAllocationBps: number;
  /** `B`, the quote's graduation threshold in its base units (`QuoteConfig.gradThreshold`). */
  gradThreshold: bigint;
  /** Share of `S - S_c` placed in the tail (Config `TailBps`). */
  tailBps: number;
}

/** Lay a curve out as positions (program `build_curve`), including its three guard bands. */
export function buildCurve(p: BuildCurveParams): CurveLayout {
  validateSegments(p.segments);
  const spacing = CURVE_TICK_SPACING;
  const total = p.totalSupply;
  const b = p.gradThreshold;
  const nominal = (total * BigInt(p.curveAllocationBps)) / BPS;
  const [tickLower, tickUpper] = curveTicks(total, nominal, b, spacing);
  const curves = expand(p.segments, tickLower, tickUpper, spacing);
  const curveSupply = calibrate(curves, spacing, b);
  if (!(curveSupply > 0n && curveSupply < total)) throw bad("Bad curve shape: curve supply out of range");
  if (!(curveSupply * BPS >= nominal * (BPS - CURVE_SUPPLY_BAND_BPS) && curveSupply * BPS <= nominal * (BPS + CURVE_SUPPLY_BAND_BPS))) {
    throw bad("This shape needs a curve allocation more than 25% away from the governed one (CurveSupplyOutOfBand)");
  }

  const positions: PlannedPosition[] = [];
  for (const c of curves) {
    const segSupply = (curveSupply * BigInt(c.sharesBps)) / BPS;
    const { anchor, moving } = nestTicks(c, spacing);
    const per = segSupply / BigInt(moving.length);
    const sa = getSqrtPriceAtTick(anchor);
    for (const t of moving) {
      const sm = getSqrtPriceAtTick(t);
      // One unit short, as in the program: the pool rounds a deposit UP, so a position sized
      // from exactly `per` could ask for `per + 1`.
      const liquidity = per === 0n ? 0n : liquidityFromAmount0(sa, sm, per - 1n);
      if (liquidity === 0n) continue;
      const [lo, hi] = anchor < t ? [anchor, t] : [t, anchor];
      positions.push({ tickLower: lo, tickUpper: hi, liquidity });
    }
  }

  const tailSupply = ((total - curveSupply) * BigInt(p.tailBps)) / BPS;
  if (tailSupply > 1n) {
    const lo = tickUpper;
    const hi = alignTick(true, MAX_TICK, spacing);
    if (!(lo < hi)) throw bad("Bad curve shape: no room for the tail");
    const liquidity = liquidityFromAmount0(getSqrtPriceAtTick(lo), getSqrtPriceAtTick(hi), tailSupply - 1n);
    if (liquidity !== 0n) positions.push({ tickLower: lo, tickUpper: hi, liquidity });
  }
  if (!(positions.length > 0 && positions.length <= MAX_POSITIONS)) throw bad("Bad curve shape: position count");

  // Opening-depth window (program `require_opening_depth`).
  const flat = liquidityFromAmount1(getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), b);
  const depth = depthAt(positions, tickLower);
  if (!(depth * BPS >= flat * MIN_OPENING_DEPTH_BPS && depth * BPS <= flat * MAX_OPENING_DEPTH_BPS)) {
    throw bad("This shape's opening depth is outside the allowed window (OpeningDepthOutOfBand)");
  }
  return { tickLower, tickUpper, curveSupply, tailSupply, positions };
}

/**
 * The sqrt price the curve reaches after `tokensOut` launch tokens are bought from a fresh
 * curve, walking the liquidity profile up from `P(0)` (program `sqrt_price_after_buy`).
 */
export function sqrtPriceAfterBuy(positions: readonly PlannedPosition[], tickLower: number, tokensOut: bigint): bigint {
  let s = getSqrtPriceAtTick(tickLower);
  if (tokensOut === 0n) return s;
  const ticks = [...new Set(positions.flatMap((p) => [p.tickLower, p.tickUpper]).filter((t) => t > tickLower))].sort((a, b) => a - b);
  let remaining = tokensOut;
  let curTick = tickLower;
  for (const nextTick of ticks) {
    const l = depthAt(positions, curTick);
    const next = getSqrtPriceAtTick(nextTick);
    if (l > 0n) {
      const available = amount0Delta(s, next, l, false);
      if (remaining <= available) {
        // √P' = L·√P / (L − Δ·√P/Q64), rounded up so the buyer never gets more than the curve sells.
        const num = l << 64n;
        const prod = remaining * s;
        if (!(num > prod)) throw bad("First buy is too large for the curve");
        const den = num - prod;
        const p = num * s;
        let q = p / den;
        if (p % den !== 0n) q += 1n;
        if (q > U128_MAX) throw bad("First buy overflows");
        return q < next ? q : next;
      }
      remaining -= available;
    }
    s = next;
    curTick = nextTick;
  }
  throw new RallyError("INVALID_AMOUNT", "The first buy is larger than the curve can sell (FirstBuyTooLarge)");
}

export interface FirstBuyPlan {
  /** Launch tokens the creator receives (<= the requested amount; the curve rounds in its own favour). */
  tokensOut: bigint;
  /** Quote the creator pays in `open_pool`: the exact value to pass as `maxFirstBuyQuote`. */
  quoteCost: bigint;
  /** The price the pool opens at. */
  sqrtPriceOpenX64: bigint;
  /** `P(0)`, the price a fresh curve starts at. */
  sqrtPriceStartX64: bigint;
}

/**
 * Where `open_pool` opens the pool for a first buy of `firstBuyTokens`, and what it costs
 * (program `open_pool`: deposits at the opening price, rounded up as Raydium pulls them).
 */
export function planFirstBuy(
  positions: readonly PlannedPosition[],
  tickLower: number,
  tickUpper: number,
  firstBuyTokens: bigint,
): FirstBuyPlan {
  const sqrtStart = getSqrtPriceAtTick(tickLower);
  const sqrtOpen = sqrtPriceAfterBuy(positions, tickLower, firstBuyTokens);
  if (!(sqrtOpen < getSqrtPriceAtTick(tickUpper))) {
    throw new RallyError("INVALID_AMOUNT", "The first buy would graduate the curve (FirstBuyTooLarge)");
  }
  let quoteNeeded = 0n;
  let bought = 0n;
  for (const p of positions) {
    const lo = getSqrtPriceAtTick(p.tickLower);
    const hi = getSqrtPriceAtTick(p.tickUpper);
    const at = amountsForLiquidity(sqrtOpen, lo, hi, p.liquidity, true);
    const t0 = amountsForLiquidity(sqrtStart, lo, hi, p.liquidity, false).amount0;
    bought += t0 > at.amount0 ? t0 - at.amount0 : 0n;
    quoteNeeded += at.amount1;
  }
  if (quoteNeeded > U64_MAX) throw bad("First buy cost overflows u64");
  if (bought > firstBuyTokens) bought = firstBuyTokens;
  return { tokensOut: bought, quoteCost: quoteNeeded, sqrtPriceOpenX64: sqrtOpen, sqrtPriceStartX64: sqrtStart };
}

/**
 * `planFirstBuy` in canonical Raydium coordinates. Rally stores every position and boundary
 * as economic quote-per-token ticks; a quote-token0 pool mirrors the raw tick range and walks
 * downward using token1 deltas. This follows the program directly instead of taking a rounded
 * reciprocal of the legacy opening sqrt price.
 */
export function planFirstBuyForOrientation(
  positions: readonly PlannedPosition[],
  tickLower: number,
  tickUpper: number,
  firstBuyTokens: bigint,
  quoteIsToken0: boolean,
): FirstBuyPlan {
  if (!quoteIsToken0) return planFirstBuy(positions, tickLower, tickUpper, firstBuyTokens);

  const sqrtStart = getSqrtPriceAtTick(-tickLower);
  let sqrtOpen = sqrtStart;
  if (firstBuyTokens > 0n) {
    const ticks = [...new Set(positions.flatMap((p) => [p.tickLower, p.tickUpper]).filter((t) => t > tickLower))].sort((a, b) => a - b);
    let remaining = firstBuyTokens;
    let currentTick = tickLower;
    let found = false;
    for (const nextEconomicTick of ticks) {
      const liquidity = depthAt(positions, currentTick);
      const next = getSqrtPriceAtTick(-nextEconomicTick);
      if (liquidity > 0n) {
        const available = amount1Delta(next, sqrtOpen, liquidity, false);
        if (remaining <= available) {
          const numerator = remaining * Q64;
          const delta = (numerator + liquidity - 1n) / liquidity;
          sqrtOpen = sqrtOpen - delta;
          if (sqrtOpen < next) sqrtOpen = next;
          found = true;
          break;
        }
        remaining -= available;
      }
      sqrtOpen = next;
      currentTick = nextEconomicTick;
    }
    if (!found) throw bad("The first buy is larger than the curve can sell (FirstBuyTooLarge)");
  }

  if (!(sqrtOpen > getSqrtPriceAtTick(-tickUpper))) {
    throw new RallyError("INVALID_AMOUNT", "The first buy would graduate the curve (FirstBuyTooLarge)");
  }
  let quoteNeeded = 0n;
  let bought = 0n;
  for (const p of positions) {
    const lo = getSqrtPriceAtTick(-p.tickUpper);
    const hi = getSqrtPriceAtTick(-p.tickLower);
    const at = amountsForLiquidity(sqrtOpen, lo, hi, p.liquidity, true);
    const atStart = amountsForLiquidity(sqrtStart, lo, hi, p.liquidity, false);
    bought += atStart.amount1 > at.amount1 ? atStart.amount1 - at.amount1 : 0n;
    quoteNeeded += at.amount0;
  }
  if (quoteNeeded > U64_MAX) throw bad("First buy cost overflows u64");
  if (bought > firstBuyTokens) bought = firstBuyTokens;
  return { tokensOut: bought, quoteCost: quoteNeeded, sqrtPriceOpenX64: sqrtOpen, sqrtPriceStartX64: sqrtStart };
}
