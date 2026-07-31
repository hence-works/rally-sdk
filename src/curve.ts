/**
 * BigInt port of the on-chain bonding curve (`CurveMath.sol`), the exact-output
 * inverses (`LaunchCurve._buyExactOut` / `_sellExactOut`), and the §4.2 anti-snipe fee
 * schedule (`LaunchFees._curveFeeBps`).
 *
 * Why it exists: a launch that has never traded has no last price, so anything derived
 * from one is dead on arrival. The curve is a pure function of `(S, S_c, B)` and the
 * bonded amount `b` — all readable off-chain — so a real price and a real fill exist
 * from block one, without an RPC round-trip per keystroke.
 *
 * Units follow CurveMath exactly — raw base-unit integers, no decimals assumed:
 *   `b`, `B`, `x_v`, `X` → quote base units;  `S`, `S_c`, `Y`, `L` → tokens, 18dp.
 * Decimals enter only through an explicit `scale` (see {scaleFor}).
 *
 * All arithmetic is exact-floor BigInt, matching Solidity's `FullMath.mulDiv` and `/`.
 * Never widen these to `number`.
 */

/** bps denominator (CurveMath.BPS). */
export const BPS = 10_000n;

/** Immutable-per-launch curve parameters (CurveMath.Curve). */
export interface Curve {
  /** total supply (18dp) */
  S: bigint;
  /** curve allocation (18dp) */
  Sc: bigint;
  /** graduation threshold (quote base units) */
  B: bigint;
  /** virtual quote reserve (quote base units) */
  xv: bigint;
  /** constant product X·Y */
  K: bigint;
}

/**
 * Build the canonical curve from `(S, S_c, B)`, exactly as `CurveMath.init`:
 * `x_v = B·(S − S_c)/S_c` and `K = S_c·x_v·(x_v + B)/B`, which give the clean identity
 * `Y(0) = S`. Returns null on params the contract would revert on, so callers can fall
 * back rather than produce nonsense.
 */
export function initCurve(S: bigint, Sc: bigint, B: bigint): Curve | null {
  if (Sc <= 0n || S < Sc || B <= 0n) return null;
  const xv = (B * (S - Sc)) / Sc;
  if (xv <= 0n) return null;
  const K = (Sc * xv * (xv + B)) / B;
  if (K <= 0n) return null;
  return { S, Sc, B, xv, K };
}

/** Quote reserve `X(b) = x_v + b`. */
export function reserveX(c: Curve, b: bigint): bigint {
  return c.xv + b;
}

/** Token reserve `Y(b) = K / X(b)` (18dp). */
export function reserveY(c: Curve, b: bigint): bigint {
  return c.K / (c.xv + b);
}

/**
 * WAD scale for a quote: `10^(36 − quoteDecimals)`. An 18dp quote uses 1e18, a 6dp
 * quote 1e30, so a price WAD is decimal-normalised and comparable across quotes — the
 * same `scale` the hook stores per launch.
 */
export function scaleFor(quoteDecimals: number): bigint {
  return 10n ** BigInt(36 - quoteDecimals);
}

/** Spot price of one whole token in the quote (WAD): `X²·scale / K`. */
export function pricePerTokenWad(c: Curve, b: bigint, scale: bigint): bigint {
  const X = c.xv + b;
  return (X * X * scale) / c.K;
}

/** Fully-diluted valuation `FDV(b) = P(b)·S`, in quote base units. */
export function fdv(c: Curve, b: bigint): bigint {
  const X = c.xv + b;
  return (X * X * c.S) / c.K;
}

/** Tokens out for adding `dQuote` at state `b`: `K/X − K/(X + dQuote)`. */
export function tokensOutForBuy(c: Curve, b: bigint, dQuote: bigint): bigint {
  const X = c.xv + b;
  return c.K / X - c.K / (X + dQuote);
}

/** Quote out for selling `dTokens` at state `b`: `X − K/(Y + dTokens)`. */
export function quoteOutForSell(c: Curve, b: bigint, dTokens: bigint): bigint {
  const X = c.xv + b;
  const Y = c.K / X;
  return X - c.K / (Y + dTokens);
}

/**
 * Net quote that must be bonded to receive exactly `dTokens` — the inverse of
 * {tokensOutForBuy}. Rounds UP, so the curve never under-charges an exact-output buy.
 * Caller must ensure `dTokens < Y(b)`.
 */
export function quoteInForBuy(c: Curve, b: bigint, dTokens: bigint): bigint {
  const X = c.xv + b;
  const Y = c.K / X;
  const denom = Y - dTokens;
  if (denom <= 0n) return 0n; // precondition violated — caller handles crossing
  const xNew = (c.K + denom - 1n) / denom;
  return xNew - X;
}

/**
 * Tokens that must be sold to withdraw exactly `dQuote` pre-fee — the inverse of
 * {quoteOutForSell}. Rounds UP, so the curve never over-pays. Caller must ensure
 * `dQuote ≤ b`.
 */
export function tokensInForSell(c: Curve, b: bigint, dQuote: bigint): bigint {
  const X = c.xv + b;
  const Y = c.K / X;
  const denom = X - dQuote;
  if (denom <= 0n) return 0n;
  const yNew = (c.K + denom - 1n) / denom;
  return yNew - Y;
}

/** Tokens paired with all `B` quote in the locked full-range LP: `L = B·K / X(B)²`. */
export function lpSeed(c: Curve): bigint {
  const XB = c.xv + c.B;
  return (c.B * c.K) / (XB * XB);
}

/** `LaunchCurve._grossUpForFee` — smallest gross with `gross − fee(gross) ≥ net`. */
export function grossUpForFee(net: bigint, feeBps: bigint): bigint {
  const denom = BPS - feeBps;
  return (net * BPS + denom - 1n) / denom;
}

/**
 * Exact-input output from the graduated pool, priced against its ACTUAL reserves.
 *
 * The locked position spans the full tick range, so within it the pool behaves as a
 * constant product on the two reserves `poolReserves(pid)` reports — and pricing against
 * those is the whole point. A straight line off spot models zero price impact, which is
 * only harmless for trades that are small relative to depth; a launch graduates with just
 * `B` of quote behind it, so an exit sized like a creator's stack is a majority-impact
 * trade and spot overstates the proceeds several-fold. Quoting that way does not merely
 * mislead the UI — the slippage bound derived from it is unreachable, so the router
 * rejects the swap with `InsufficientOutput` and the position looks unsellable.
 *
 * v4 takes the LP fee off the INPUT of an exact-input swap, so the fee is applied before
 * the invariant, matching `Pool.swap`.
 *
 * Accurate to well under a tenth of a percent against a live pool. It is not exact: the
 * range is finite rather than truly `(0, ∞)`, so the reserves imply a slightly different
 * curvature than pure `xy = k`. That residual is why a graduated quote stays
 * `exact: false` and keeps the wider tolerance — which now absorbs other traders moving
 * the pool between quote and inclusion, its actual job.
 *
 * @param reserveIn  reserve of the leg being paid in, base units.
 * @param reserveOut reserve of the leg being received, base units.
 * @param poolFeeBps the graduated pool's LP fee (POOL_FEE_BPS).
 */
export function clmmAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  poolFeeBps: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const fee = poolFeeBps >= BPS ? BPS - 1n : poolFeeBps < 0n ? 0n : poolFeeBps;
  const inAfterFee = (amountIn * (BPS - fee)) / BPS;
  if (inAfterFee <= 0n) return 0n;
  // Floor, so the estimate never sits above what the pool would actually pay.
  return (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
}

/** Governance params driving the §4.2 anti-snipe fee decay. */
export interface CurveFeeParams {
  /** CURVE_FEE_START_BPS — fee at launch. */
  startBps: bigint;
  /** CURVE_FEE_END_BPS — the floor it decays to. */
  endBps: bigint;
  /** CURVE_FEE_DECAY — decay window, seconds. */
  decay: bigint;
}

/**
 * Live curve fee in bps, mirroring `LaunchFees._curveFeeBps`: a linear decay from START
 * at launch to END after the window. A `decay == 0` or `START ≤ END` misconfig collapses
 * to the floor rather than underflowing, and the result is capped below BPS so the
 * grossup divisor stays non-zero.
 */
export function curveFeeBps(
  p: CurveFeeParams,
  launchedAt: number,
  nowSeconds: number,
): bigint {
  const elapsed = nowSeconds > launchedAt ? BigInt(nowSeconds - launchedAt) : 0n;
  let feeBps: bigint;
  if (p.decay === 0n || elapsed >= p.decay || p.startBps <= p.endBps) {
    feeBps = p.endBps;
  } else {
    feeBps = p.startBps - ((p.startBps - p.endBps) * elapsed) / p.decay;
  }
  return feeBps >= BPS ? BPS - 1n : feeBps;
}

/** Result of a curve preview. */
export interface CurvePreview {
  /** Output in the destination token's base units (18dp buying, quote selling). */
  amountOut: bigint;
  /** Curve fee charged on this trade, in quote base units. */
  feeQuote: bigint;
  /** True when the trade bonds `b` to `B` and graduates the launch mid-swap. */
  crossesGraduation: boolean;
}

/**
 * Exact-in BUY: `grossQuote` in → tokens out, mirroring `LaunchCurve._buy`. The fee
 * comes off the input first; the net bonds into `b`.
 *
 * A buy large enough to bond `b` up to `B` graduates mid-swap: the curve pays only
 * `Y(b) − Y(B)`, and the remainder trades against the JIT-seeded CLMM. That leg is
 * modelled as constant-product over the seed reserves `(B, L)` — the same approximation
 * `CurveMath.recovery` uses — so a crossing quote is close but not exact, and is
 * flagged via `crossesGraduation`.
 */
export function previewBuy(
  c: Curve,
  b: bigint,
  grossQuote: bigint,
  feeBps: bigint,
  poolFeeBps: bigint,
): CurvePreview {
  if (grossQuote <= 0n) {
    return { amountOut: 0n, feeQuote: 0n, crossesGraduation: false };
  }
  const fee = (grossQuote * feeBps) / BPS;
  const net = grossQuote - fee;

  if (b + net < c.B) {
    return {
      amountOut: tokensOutForBuy(c, b, net),
      feeQuote: fee,
      crossesGraduation: false,
    };
  }

  const netToB = c.B - b;
  const grossToB = grossUpForFee(netToB, feeBps);
  const curveTokens = tokensOutForBuy(c, b, netToB);
  const remainder = grossQuote > grossToB ? grossQuote - grossToB : 0n;

  const inAfterFee = remainder - (remainder * poolFeeBps) / BPS;
  const L = lpSeed(c);
  const poolTokens = inAfterFee > 0n ? (L * inAfterFee) / (c.B + inAfterFee) : 0n;

  return {
    amountOut: curveTokens + poolTokens,
    feeQuote: grossToB - netToB + (remainder - inAfterFee),
    crossesGraduation: true,
  };
}

/**
 * Exact-in SELL: `tokensIn` (18dp) → net quote out, mirroring `LaunchCurve._sell` — the
 * curve computes the gross quote, then the fee comes off the OUTPUT. Sells never cross
 * `B`; the `b` clamp is defensive.
 */
export function previewSell(
  c: Curve,
  b: bigint,
  tokensIn: bigint,
  feeBps: bigint,
): CurvePreview {
  if (tokensIn <= 0n) {
    return { amountOut: 0n, feeQuote: 0n, crossesGraduation: false };
  }
  let quoteOut = quoteOutForSell(c, b, tokensIn);
  if (quoteOut > b) quoteOut = b;
  const fee = (quoteOut * feeBps) / BPS;
  return { amountOut: quoteOut - fee, feeQuote: fee, crossesGraduation: false };
}

/** Result of an exact-output preview: what the trade costs to get `wantOut`. */
export interface CurveCostPreview {
  /** Input required, in the input leg's base units. */
  amountIn: bigint;
  feeQuote: bigint;
  crossesGraduation: boolean;
}

/**
 * Exact-out BUY: gross quote needed to receive exactly `wantTokens`, mirroring
 * `LaunchCurve._buyExactOut`. A request at or beyond the curve's remaining tokens
 * graduates: the curve delivers `Y(b) − Y(B)` for `grossToB`, and the shortfall is
 * served by the fresh CLMM — approximated here over the seed reserves, so the figure
 * is flagged `crossesGraduation` and deserves the wider slippage band.
 */
export function previewBuyExactOut(
  c: Curve,
  b: bigint,
  wantTokens: bigint,
  feeBps: bigint,
  poolFeeBps: bigint,
): CurveCostPreview {
  if (wantTokens <= 0n) {
    return { amountIn: 0n, feeQuote: 0n, crossesGraduation: false };
  }
  const curveTokens = tokensOutForBuy(c, b, c.B - b); // Y(b) − Y(B)
  if (wantTokens >= curveTokens) {
    const netToB = c.B - b;
    const grossToB = grossUpForFee(netToB, feeBps);
    const shortfall = wantTokens - curveTokens;
    const L = lpSeed(c);
    // Constant product over the seed reserves (B, L), inverted, then grossed up for
    // the post-grad pool fee on the input leg.
    const poolIn = shortfall > 0n && L > shortfall ? (c.B * shortfall) / (L - shortfall) + 1n : 0n;
    const poolGross = poolIn > 0n ? grossUpForFee(poolIn, poolFeeBps) : 0n;
    return {
      amountIn: grossToB + poolGross,
      feeQuote: grossToB - netToB + (poolGross - poolIn),
      crossesGraduation: true,
    };
  }
  const net = quoteInForBuy(c, b, wantTokens);
  const gross = grossUpForFee(net, feeBps);
  return { amountIn: gross, feeQuote: gross - net, crossesGraduation: false };
}

/**
 * Exact-out SELL: tokens needed to net exactly `wantQuote`, mirroring
 * `LaunchCurve._sellExactOut`. Returns null when `wantQuote` grossed up for the fee
 * exceeds the bonded reserve — on-chain that is `ExactOutputExceedsReserve`.
 */
export function previewSellExactOut(
  c: Curve,
  b: bigint,
  wantQuote: bigint,
  feeBps: bigint,
): CurveCostPreview | null {
  if (wantQuote <= 0n) {
    return { amountIn: 0n, feeQuote: 0n, crossesGraduation: false };
  }
  const quoteGross = grossUpForFee(wantQuote, feeBps);
  if (quoteGross > b) return null;
  const dTok = tokensInForSell(c, b, quoteGross);
  return { amountIn: dTok, feeQuote: quoteGross - wantQuote, crossesGraduation: false };
}
