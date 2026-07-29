/**
 * The curve is money math: every figure here becomes a slippage bound a user signs.
 * These tests pin the identities the Solidity guarantees (`Y(0) = S`, the seed price
 * `P(B)`, exact-out inverting exact-in) rather than golden numbers, so they stay
 * meaningful if the registry defaults change.
 */
import { describe, expect, it } from "vitest";
import {
  BPS,
  curveFeeBps,
  fdv,
  grossUpForFee,
  initCurve,
  lpSeed,
  previewBuy,
  previewBuyExactOut,
  previewSell,
  previewSellExactOut,
  pricePerTokenWad,
  quoteInForBuy,
  reserveY,
  scaleFor,
  tokensOutForBuy,
  type Curve,
} from "../src/curve";

// The shipped registry defaults: 1e9 supply, 80% on the curve, B = 10 wETH.
const S = 1_000_000_000n * 10n ** 18n;
const SC = (S * 80n) / 100n;
const B = 10n * 10n ** 18n;
const curve = initCurve(S, SC, B)!;

describe("initCurve", () => {
  it("satisfies Y(0) = S", () => {
    // The whole point of the x_v / K construction: at b = 0 the curve's token reserve
    // is the FULL supply, not just the curve allocation.
    const y0 = reserveY(curve, 0n);
    const drift = S > y0 ? S - y0 : y0 - S;
    expect(drift * 10n ** 9n < S).toBe(true); // within a part per billion of exact
  });

  it("leaves exactly the curve allocation sold at B", () => {
    const sold = reserveY(curve, 0n) - reserveY(curve, B);
    const drift = sold > SC ? sold - SC : SC - sold;
    expect(drift * 10n ** 9n < SC).toBe(true);
  });

  it("rejects params the contract would revert on", () => {
    expect(initCurve(S, 0n, B)).toBeNull();
    expect(initCurve(SC, S, B)).toBeNull(); // S < Sc
    expect(initCurve(S, SC, 0n)).toBeNull();
  });
});

describe("pricing", () => {
  it("prices a whole token in the quote, decimal-normalised", () => {
    // An 18dp quote uses 1e18 and a 6dp quote 1e30, so the same launch prices the same.
    const p18 = pricePerTokenWad(curve, 0n, scaleFor(18));
    const p6 = pricePerTokenWad(curve, 0n, scaleFor(6));
    expect(p6).toBe(p18 * 10n ** 12n);
    expect(p18).toBeGreaterThan(0n);
  });

  it("rises monotonically with bonded quote", () => {
    let prev = 0n;
    for (const b of [0n, B / 8n, B / 4n, B / 2n, B]) {
      const p = pricePerTokenWad(curve, b, scaleFor(18));
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it("computes FDV as price × supply", () => {
    expect(fdv(curve, 0n)).toBeGreaterThan(0n);
    expect(fdv(curve, B)).toBeGreaterThan(fdv(curve, 0n));
  });

  it("seeds the LP at exactly P(B) (invariant I-3)", () => {
    // L = B / P(B): the JIT-seeded pool opens at the graduation price, leaving no arb gap.
    const L = lpSeed(curve);
    const priceWad = pricePerTokenWad(curve, B, scaleFor(18));
    const implied = (B * 10n ** 18n) / L; // quote per whole token, WAD
    const drift = implied > priceWad ? implied - priceWad : priceWad - implied;
    expect(drift * 10n ** 6n < priceWad).toBe(true);
  });
});

describe("curveFeeBps", () => {
  const params = { startBps: 2_500n, endBps: 100n, decay: 600n };

  it("starts at the anti-snipe rate and decays linearly to the floor", () => {
    expect(curveFeeBps(params, 1_000, 1_000)).toBe(2_500n);
    expect(curveFeeBps(params, 1_000, 1_300)).toBe(1_300n); // halfway
    expect(curveFeeBps(params, 1_000, 1_600)).toBe(100n);
    expect(curveFeeBps(params, 1_000, 9_999)).toBe(100n);
  });

  it("collapses to the floor on a misconfig instead of underflowing", () => {
    expect(curveFeeBps({ startBps: 2_500n, endBps: 100n, decay: 0n }, 0, 10)).toBe(100n);
    expect(curveFeeBps({ startBps: 50n, endBps: 100n, decay: 600n }, 0, 10)).toBe(100n);
  });

  it("caps below BPS so the grossup divisor stays non-zero", () => {
    const fee = curveFeeBps({ startBps: 20_000n, endBps: 100n, decay: 600n }, 0, 0);
    expect(fee).toBe(BPS - 1n);
    expect(grossUpForFee(1_000n, fee)).toBeGreaterThan(0n);
  });

  it("treats a future launch timestamp as t=0 rather than going negative", () => {
    expect(curveFeeBps(params, 5_000, 1_000)).toBe(2_500n);
  });
});

describe("previewBuy", () => {
  it("takes the fee off the input, then bonds the rest", () => {
    const gross = 10n ** 18n;
    const feeBps = 2_500n;
    const preview = previewBuy(curve, 0n, gross, feeBps, 30n);
    expect(preview.feeQuote).toBe((gross * feeBps) / BPS);
    expect(preview.amountOut).toBe(tokensOutForBuy(curve, 0n, gross - preview.feeQuote));
    expect(preview.crossesGraduation).toBe(false);
  });

  it("flags a buy that bonds b all the way to B", () => {
    const preview = previewBuy(curve, 0n, B * 2n, 100n, 30n);
    expect(preview.crossesGraduation).toBe(true);
    // It still delivers at least everything the curve had left.
    expect(preview.amountOut).toBeGreaterThanOrEqual(tokensOutForBuy(curve, 0n, B));
  });

  it("returns zero for a zero-size trade", () => {
    expect(previewBuy(curve, 0n, 0n, 100n, 30n).amountOut).toBe(0n);
  });

  it("delivers less per unit as the curve fills", () => {
    const size = 10n ** 17n;
    const early = previewBuy(curve, 0n, size, 100n, 30n).amountOut;
    const late = previewBuy(curve, B / 2n, size, 100n, 30n).amountOut;
    expect(late).toBeLessThan(early);
  });
});

describe("previewSell", () => {
  it("takes the fee off the output", () => {
    const tokens = 1_000_000n * 10n ** 18n;
    const b = B / 2n;
    const preview = previewSell(curve, b, tokens, 100n);
    expect(preview.amountOut).toBeGreaterThan(0n);
    expect(preview.feeQuote).toBeGreaterThan(0n);
    expect(preview.crossesGraduation).toBe(false);
  });

  it("never pays out more than the bonded reserve", () => {
    const preview = previewSell(curve, B / 10n, S, 100n);
    expect(preview.amountOut).toBeLessThanOrEqual(B / 10n);
  });

  it("round-trips a buy back to at most what went in (fees make it strictly less)", () => {
    const spend = 10n ** 18n;
    const bought = previewBuy(curve, 0n, spend, 100n, 30n);
    const back = previewSell(curve, spend - bought.feeQuote, bought.amountOut, 100n);
    expect(back.amountOut).toBeLessThan(spend);
  });
});

describe("exact-output previews", () => {
  it("inverts the exact-in buy", () => {
    const want = 1_000_000n * 10n ** 18n;
    const cost = previewBuyExactOut(curve, 0n, want, 100n, 30n);
    expect(cost.crossesGraduation).toBe(false);
    // Spending the computed input must deliver at least what was asked for.
    const forward = previewBuy(curve, 0n, cost.amountIn, 100n, 30n);
    expect(forward.amountOut).toBeGreaterThanOrEqual(want);
    // …and not wildly more: rounding is a few wei, not a percent.
    expect(forward.amountOut - want).toBeLessThan(want / 1_000_000n + 10n);
  });

  it("prices the net quote via the curve inverse plus the fee grossup", () => {
    const want = 1_000n * 10n ** 18n;
    const net = quoteInForBuy(curve, 0n, want);
    const cost = previewBuyExactOut(curve, 0n, want, 2_500n, 30n);
    expect(cost.amountIn).toBe(grossUpForFee(net, 2_500n));
    expect(cost.feeQuote).toBe(cost.amountIn - net);
  });

  it("flags an exact-out buy large enough to graduate", () => {
    const all = tokensOutForBuy(curve, 0n, B);
    const cost = previewBuyExactOut(curve, 0n, all + 10n ** 18n, 100n, 30n);
    expect(cost.crossesGraduation).toBe(true);
    expect(cost.amountIn).toBeGreaterThan(B);
  });

  it("inverts the exact-in sell", () => {
    const b = B / 2n;
    const want = 10n ** 17n;
    const cost = previewSellExactOut(curve, b, want, 100n)!;
    const forward = previewSell(curve, b, cost.amountIn, 100n);
    expect(forward.amountOut).toBeGreaterThanOrEqual(want);
  });

  it("refuses to withdraw more than the bonded reserve", () => {
    expect(previewSellExactOut(curve, 10n ** 15n, B, 100n)).toBeNull();
  });
});

describe("grossUpForFee", () => {
  it("rounds up so gross − fee ≥ net", () => {
    for (const net of [1n, 7n, 999n, 10n ** 18n, 123_456_789n]) {
      for (const feeBps of [0n, 1n, 100n, 2_500n, 9_999n]) {
        const gross = grossUpForFee(net, feeBps);
        expect(gross - (gross * feeBps) / BPS).toBeGreaterThanOrEqual(net);
      }
    }
  });
});

describe("scaleFor", () => {
  it("normalises a price WAD across quote decimals", () => {
    expect(scaleFor(18)).toBe(10n ** 18n);
    expect(scaleFor(6)).toBe(10n ** 30n);
  });
});

// Sanity: a fully independent construction of the curve agrees with initCurve.
describe("curve construction", () => {
  it("matches CurveMath.init term by term", () => {
    const xv = (B * (S - SC)) / SC;
    const K = (SC * xv * (xv + B)) / B;
    const expected: Curve = { S, Sc: SC, B, xv, K };
    expect(curve).toEqual(expected);
  });
});
