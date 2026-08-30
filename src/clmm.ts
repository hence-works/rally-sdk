/**
 * Concentrated-liquidity math for PROTOCOL v2 launches.
 *
 * v2's bonding curve is not approximated by v4 liquidity, it IS v4 liquidity: the launch
 * supply is minted as a ladder of single-sided ranges at and above the opening price, and
 * `PoolManager` prices every trade against it. So quoting a v2 trade is quoting an
 * ordinary v4 pool, and none of `curve.ts` (v1's virtual constant-product reserve)
 * applies: a constant-product quote against a concentrated ladder is not approximate, it
 * is wrong, in either direction, by however far the trade walks past the range it started
 * in.
 *
 * The ladder is small and knowable — at most `MAX_POSITIONS_TOTAL` (16) plus the tail,
 * read once from `positionsOf` — so the whole swap is simulated here rather than through a
 * quoter contract. That keeps a quote to the same one round trip a v1 quote takes and
 * leaves the SDK with no new deployed dependency.
 *
 * Every function is exact integer math against Uniswap's own rounding. Nothing here
 * touches floating point: these are quote amounts.
 */

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** v4 TickMath bounds. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** One range of a launch's ladder, as `positionsOf` returns it. */
export interface LadderPosition {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/**
 * `TickMath.getSqrtPriceAtTick`, ported exactly from Uniswap's integer implementation.
 *
 * The constants are the canonical Q128.128 binary-expansion table, one per bit of |tick|.
 * Ported rather than approximated because the result feeds a price and then an amount.
 */
export function sqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick ${tick} out of range`);
  }
  const abs = BigInt(tick < 0 ? -tick : tick);
  let r =
    (abs & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (bit: bigint, k: bigint): void => {
    if ((abs & bit) !== 0n) r = (r * k) >> 128n;
  };
  mul(0x2n, 0xfff97272373d413259a46990580e213an);
  mul(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  mul(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  mul(0x10n, 0xffcb9843d60f6159c9db58835c926644n);
  mul(0x20n, 0xff973b41fa98c081472e6896dfb254c0n);
  mul(0x40n, 0xff2ea16466c96a3843ec78b326b52861n);
  mul(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n);
  mul(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  mul(0x200n, 0xf987a7253ac413176f2b074cf7815e54n);
  mul(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n);
  mul(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  mul(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  mul(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  mul(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n);
  mul(0x8000n, 0x31be135f97d08fd981231505542fcfa6n);
  mul(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  mul(0x20000n, 0x5d6af8dedb81196699c329225ee604n);
  mul(0x40000n, 0x2216e584f5fa1ea926041bedfe98n);
  mul(0x80000n, 0x48a170391f7dc42444e8fa2n);
  // The table expands NEGATIVE ticks; a positive one is the reciprocal.
  if (tick > 0) r = MAX_UINT256 / r;
  // Q128.128 to Q64.96, rounding up so a tick's price is never understated.
  return (r >> 32n) + (r % (1n << 32n) === 0n ? 0n : 1n);
}

const divUp = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** `SqrtPriceMath.getAmount0Delta` — the currency0 held between two prices. */
export function amount0Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (lo <= 0n) return 0n;
  const num = liquidity << 96n;
  const diff = hi - lo;
  return roundUp ? divUp(divUp(num * diff, hi), lo) : (num * diff) / hi / lo;
}

/** `SqrtPriceMath.getAmount1Delta` — the currency1 held between two prices. */
export function amount1Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  const num = liquidity * (hi - lo);
  return roundUp ? divUp(num, Q96) : num / Q96;
}

/**
 * How much of one currency a whole ladder holds at `sqrtPriceX96`.
 *
 * Ranges the price has not reached hold only the launch token; ranges it has passed hold
 * only quote; the one straddling spot is split. Summed over every position, and truncated
 * per position exactly as v4 truncates it, so this agrees with the pool rather than
 * approximating it.
 *
 * With `wantCurrency0: false` and the quote as currency1 this is the launch's `bonded` —
 * the same number `RallyHookV2.bondedOf` computes on chain.
 */
export function ladderAmount(
  ladder: readonly LadderPosition[],
  sqrtPriceX96: bigint,
  wantCurrency0: boolean,
): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  let total = 0n;
  for (const p of ladder) {
    if (p.liquidity <= 0n) continue;
    const lo = sqrtPriceAtTick(p.tickLower);
    const hi = sqrtPriceAtTick(p.tickUpper);
    if (hi <= lo) continue;
    const c = sqrtPriceX96 < lo ? lo : sqrtPriceX96 > hi ? hi : sqrtPriceX96;
    total += wantCurrency0
      ? amount0Delta(c, hi, p.liquidity, false)
      : amount1Delta(lo, c, p.liquidity, false);
  }
  return total;
}

/**
 * The ladder as a tick-indexed liquidity map: every boundary, with the net liquidity that
 * becomes active crossing it upward.
 *
 * Built rather than read from the pool because a shaped v2 curve NESTS positions (§4.2), so
 * several ranges overlap and the active liquidity at a price is a sum, not one position's.
 * Treating the ladder as a list of disjoint ranges is the mistake this exists to prevent.
 */
export function tickMapOf(ladder: readonly LadderPosition[]): Array<{ tick: number; net: bigint }> {
  const net = new Map<number, bigint>();
  for (const p of ladder) {
    if (p.liquidity <= 0n || p.tickUpper <= p.tickLower) continue;
    net.set(p.tickLower, (net.get(p.tickLower) ?? 0n) + p.liquidity);
    net.set(p.tickUpper, (net.get(p.tickUpper) ?? 0n) - p.liquidity);
  }
  return [...net.entries()]
    .filter(([, n]) => n !== 0n)
    .map(([tick, n]) => ({ tick, net: n }))
    .sort((a, b) => a.tick - b.tick);
}

/** Liquidity in range at `sqrtPriceX96`. */
export function liquidityAt(ladder: readonly LadderPosition[], sqrtPriceX96: bigint): bigint {
  let total = 0n;
  for (const p of ladder) {
    if (p.liquidity <= 0n) continue;
    if (sqrtPriceX96 >= sqrtPriceAtTick(p.tickLower) && sqrtPriceX96 < sqrtPriceAtTick(p.tickUpper)) {
      total += p.liquidity;
    }
  }
  return total;
}

/** `SqrtPriceMath.getNextSqrtPriceFromInput`, for the currency0 side. */
function nextFromAmount0(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtP;
  const numerator = liquidity << 96n;
  if (add) {
    const denom = numerator + amount * sqrtP;
    return divUp(numerator * sqrtP, denom);
  }
  const product = amount * sqrtP;
  if (product >= numerator) throw new RangeError("amount0 exceeds reserves");
  return divUp(numerator * sqrtP, numerator - product);
}

/** `SqrtPriceMath.getNextSqrtPriceFromInput`, for the currency1 side. */
function nextFromAmount1(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (add) return sqrtP + (amount * Q96) / liquidity;
  const quotient = divUp(amount * Q96, liquidity);
  if (sqrtP <= quotient) throw new RangeError("amount1 exceeds reserves");
  return sqrtP - quotient;
}

/** One point on a curve: what a token costs once this much quote is in. */
export interface CurvePricePoint {
  sqrtPriceX96: bigint;
  /** Quote the ladder holds at this price. 0 at the open, `B` at the top. */
  quoteLocked: bigint;
  /** Quote per whole token, decimal-normalised WAD. */
  priceWad: bigint;
}

/**
 * The shape of a curve as a price-versus-quote-raised series.
 *
 * This is what a curve shape actually MEANS to anyone looking at one: how fast the price
 * climbs as money comes in. A segment list does not say that, and neither does a bar
 * chart of liquidity depth, because depth and price move inversely and over a range whose
 * ends are set by `B`.
 *
 * Sampled by PRICE rather than by simulating buys: the quote a ladder holds at a price is
 * a closed form (`ladderAmount`), so a whole curve costs a few dozen evaluations and no
 * swap simulation. Both axes are exact at every point.
 *
 * Ticks are sampled linearly, which spaces the points evenly in log-price, so the early
 * stretch of the curve gets the resolution it needs.
 */
export function curvePricePoints(
  ladder: readonly LadderPosition[],
  scale: bigint,
  samples = 48,
): CurvePricePoint[] {
  if (ladder.length === 0) return [];
  const lo = ladder.reduce((m, p) => (p.tickLower < m ? p.tickLower : m), MAX_TICK);
  // The tail runs to the top of the usable range, so the chart would be mostly empty if
  // it were included. Bound at the highest tick that is not the tail's.
  const uppers = [...new Set(ladder.map((p) => p.tickUpper))].sort((a, b) => a - b);
  const hi = uppers.length > 1 ? uppers[uppers.length - 2]! : uppers[0]!;
  const out: CurvePricePoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const tick = Math.round(lo + ((hi - lo) * i) / samples);
    const sqrtPriceX96 = sqrtPriceAtTick(tick);
    out.push({
      sqrtPriceX96,
      quoteLocked: ladderAmount(ladder, sqrtPriceX96, false),
      // A v2 launch token is always currency0 (I-7), so the quote is currency1.
      priceWad: (((sqrtPriceX96 * sqrtPriceX96) >> 96n) * scale) >> 96n,
    });
  }
  return out;
}

export interface SwapResult {
  /** Consumed of the input currency. Below the request only when the ladder ran dry. */
  amountIn: bigint;
  /** Delivered of the output currency. */
  amountOut: bigint;
  /** Post-swap price, which is what decides whether the launch graduated. */
  sqrtPriceX96: bigint;
  /** True when the ladder could not fill the whole request. */
  exhausted: boolean;
}

/**
 * Simulate a swap against a v2 launch's ladder.
 *
 * A faithful walk of v4's own loop: absorb as much as the current range allows, cross the
 * boundary, pick up the liquidity that becomes active, repeat. `zeroForOne` sells
 * currency0 for currency1 and moves the price DOWN; the other direction moves it up.
 *
 * The pool fee is deliberately NOT applied here. A Rally v2 swap's fee is asymmetric —
 * the pool charges it on a buy, the hook takes it off the quote leg on a sell (§5.1) — so
 * the caller applies it on the correct side. Doing it inside would make one of the two
 * directions silently wrong.
 *
 * `exactIn: false` treats `amount` as the desired OUTPUT.
 */
export function simulateSwap(
  ladder: readonly LadderPosition[],
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
  amount: bigint,
  exactIn = true,
): SwapResult {
  const ticks = tickMapOf(ladder);
  let sqrtP = sqrtPriceX96;
  let liquidity = liquidityAt(ladder, sqrtP);
  let remaining = amount;
  let amountIn = 0n;
  let amountOut = 0n;
  // Bounded by the ladder's own boundary count (<= 2 per position) plus one, so a
  // malformed ladder cannot spin.
  const maxSteps = ticks.length + 2;

  for (let step = 0; step < maxSteps && remaining > 0n; step++) {
    // The next initialized boundary in the direction of travel.
    const next = zeroForOne
      ? [...ticks].reverse().find((t) => sqrtPriceAtTick(t.tick) < sqrtP)
      : ticks.find((t) => sqrtPriceAtTick(t.tick) > sqrtP);
    const limit = next
      ? sqrtPriceAtTick(next.tick)
      : zeroForOne
        ? MIN_SQRT_PRICE + 1n
        : MAX_SQRT_PRICE - 1n;

    if (liquidity > 0n) {
      // What this range can absorb before the price reaches `limit`.
      const maxIn = zeroForOne
        ? amount0Delta(limit, sqrtP, liquidity, true)
        : amount1Delta(sqrtP, limit, liquidity, true);
      const maxOut = zeroForOne
        ? amount1Delta(limit, sqrtP, liquidity, false)
        : amount0Delta(sqrtP, limit, liquidity, false);
      const cap = exactIn ? maxIn : maxOut;

      if (remaining >= cap) {
        // Consume the whole range and cross.
        amountIn += maxIn;
        amountOut += maxOut;
        remaining -= cap;
        sqrtP = limit;
      } else {
        // The trade ends inside this range.
        const target = exactIn
          ? zeroForOne
            ? nextFromAmount0(sqrtP, liquidity, remaining, true)
            : nextFromAmount1(sqrtP, liquidity, remaining, true)
          : zeroForOne
            ? nextFromAmount1(sqrtP, liquidity, remaining, false)
            : nextFromAmount0(sqrtP, liquidity, remaining, false);
        amountIn += zeroForOne
          ? amount0Delta(target, sqrtP, liquidity, true)
          : amount1Delta(sqrtP, target, liquidity, true);
        amountOut += zeroForOne
          ? amount1Delta(target, sqrtP, liquidity, false)
          : amount0Delta(sqrtP, target, liquidity, false);
        sqrtP = target;
        remaining = 0n;
        break;
      }
    } else if (next) {
      // A GAP between ranges: no depth here, so the price moves to the next boundary
      // without trading. Only valid because there is more ladder beyond it.
      sqrtP = limit;
    } else {
      // Past the end of the ladder with nothing left to trade against. Stop at the last
      // real price rather than running to the TickMath bound: v4 itself would move the
      // price to the swap's limit here, but reporting that as a quote would answer an
      // unfillable trade with a price no liquidity ever supported.
      break;
    }

    if (!next) break; // ran off the end of the ladder
    // Crossing upward adds the boundary's net liquidity; downward removes it.
    liquidity += zeroForOne ? -next.net : next.net;
    if (liquidity < 0n) liquidity = 0n;
  }

  return { amountIn, amountOut, sqrtPriceX96: sqrtP, exhausted: remaining > 0n };
}
