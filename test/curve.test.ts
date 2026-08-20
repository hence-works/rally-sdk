/**
 * The curve is money math: every figure here becomes a slippage bound a user signs.
 * These tests pin the identities the Solidity guarantees (`Y(0) = S`, the seed price
 * `P(B)`, exact-out inverting exact-in) rather than golden numbers, so they stay
 * meaningful if the registry defaults change.
 */
import { describe, expect, it } from "vitest";
import {
  BPS,
  clmmAmountIn,
  clmmAmountOut,
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
  curveTokenReserve,
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
    const preview = previewBuy(curve, 0n, reserveY(curve, 0n), gross, feeBps, 30n);
    expect(preview.feeQuote).toBe((gross * feeBps) / BPS);
    expect(preview.amountOut).toBe(tokensOutForBuy(curve, 0n, reserveY(curve, 0n), gross - preview.feeQuote));
    expect(preview.crossesGraduation).toBe(false);
  });

  it("flags a buy that bonds b all the way to B", () => {
    const preview = previewBuy(curve, 0n, reserveY(curve, 0n), B * 2n, 100n, 30n);
    expect(preview.crossesGraduation).toBe(true);
    // It still delivers at least everything the curve had left.
    expect(preview.amountOut).toBeGreaterThanOrEqual(tokensOutForBuy(curve, 0n, reserveY(curve, 0n), B));
  });

  it("returns zero for a zero-size trade", () => {
    expect(previewBuy(curve, 0n, reserveY(curve, 0n), 0n, 100n, 30n).amountOut).toBe(0n);
  });

  it("delivers less per unit as the curve fills", () => {
    const size = 10n ** 17n;
    const early = previewBuy(curve, 0n, reserveY(curve, 0n), size, 100n, 30n).amountOut;
    const late = previewBuy(curve, B / 2n, reserveY(curve, B / 2n), size, 100n, 30n).amountOut;
    expect(late).toBeLessThan(early);
  });
});

describe("previewSell", () => {
  it("takes the fee off the output", () => {
    const tokens = 1_000_000n * 10n ** 18n;
    const b = B / 2n;
    const preview = previewSell(curve, b, reserveY(curve, b), tokens, 100n);
    expect(preview.amountOut).toBeGreaterThan(0n);
    expect(preview.feeQuote).toBeGreaterThan(0n);
    expect(preview.crossesGraduation).toBe(false);
  });

  it("never pays out more than the bonded reserve", () => {
    const preview = previewSell(curve, B / 10n, reserveY(curve, B / 10n), S, 100n);
    expect(preview.amountOut).toBeLessThanOrEqual(B / 10n);
  });

  it("round-trips a buy back to at most what went in (fees make it strictly less)", () => {
    const spend = 10n ** 18n;
    const bought = previewBuy(curve, 0n, reserveY(curve, 0n), spend, 100n, 30n);
    // Sell back against the real post-buy pair, which is what the contract stores.
    const back = previewSell(curve, spend - bought.feeQuote, S - bought.amountOut, bought.amountOut, 100n);
    expect(back.amountOut).toBeLessThan(spend);
  });
});

describe("exact-output previews", () => {
  it("inverts the exact-in buy", () => {
    const want = 1_000_000n * 10n ** 18n;
    const cost = previewBuyExactOut(curve, 0n, reserveY(curve, 0n), want, 100n, 30n);
    expect(cost.crossesGraduation).toBe(false);
    // Spending the computed input must deliver at least what was asked for.
    const forward = previewBuy(curve, 0n, reserveY(curve, 0n), cost.amountIn, 100n, 30n);
    expect(forward.amountOut).toBeGreaterThanOrEqual(want);
    // …and not wildly more: rounding is a few wei, not a percent.
    expect(forward.amountOut - want).toBeLessThan(want / 1_000_000n + 10n);
  });

  it("prices the net quote via the curve inverse plus the fee grossup", () => {
    const want = 1_000n * 10n ** 18n;
    const net = quoteInForBuy(curve, 0n, reserveY(curve, 0n), want);
    const cost = previewBuyExactOut(curve, 0n, reserveY(curve, 0n), want, 2_500n, 30n);
    expect(cost.amountIn).toBe(grossUpForFee(net, 2_500n));
    expect(cost.feeQuote).toBe(cost.amountIn - net);
  });

  it("flags an exact-out buy large enough to graduate", () => {
    const all = tokensOutForBuy(curve, 0n, reserveY(curve, 0n), B);
    const cost = previewBuyExactOut(curve, 0n, reserveY(curve, 0n), all + 10n ** 18n, 100n, 30n);
    expect(cost.crossesGraduation).toBe(true);
    expect(cost.amountIn).toBeGreaterThan(B);
  });

  it("inverts the exact-in sell", () => {
    const b = B / 2n;
    const want = 10n ** 17n;
    const cost = previewSellExactOut(curve, b, reserveY(curve, b), want, 100n)!;
    const forward = previewSell(curve, b, reserveY(curve, b), cost.amountIn, 100n);
    expect(forward.amountOut).toBeGreaterThanOrEqual(want);
  });

  it("refuses to withdraw more than the bonded reserve", () => {
    expect(previewSellExactOut(curve, 10n ** 15n, reserveY(curve, 10n ** 15n), B, 100n)).toBeNull();
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

// ─────────────────────────────────────────────────────────────────────────────
// Graduated-pool pricing (clmmAmountOut)
//
// Regression for a real staging failure: a graduated pool was quoted off spot
// (`poolPriceWad`), which models zero price impact. A creator holding 61% of supply
// tried to exit into a pool holding ~0.837 wETH / 191.2M tokens; spot said 2.5719
// wETH, the pool actually paid 0.6298, and the 5% bound derived from spot was
// unreachable — so `RallyRouter` reverted `InsufficientOutput` and the position
// looked unsellable. The figures below are the live on-chain state and the fill the
// pool really produced, captured from Sepolia.
// ─────────────────────────────────────────────────────────────────────────────
describe("clmmAmountOut — graduated pool", () => {
  // Sepolia launch 0xba5e4840cc84ff5f1795ceaf77b790df014b7658, hook 0x1B8e0c41…
  const Q_RESERVE = 836740873017552922n; // 0.83674 wETH
  const T_RESERVE = 191218100082752180896397374n; // 191.218M tokens
  const POOL_FEE_BPS = 100n; // 1%
  const FULL_STACK = 587740113987349419220428730n; // 587.74M tokens
  const ACTUAL_FILL = 629776740259494485n; // what the pool paid, on-chain

  // NOTE on the captured fill: it was produced BEFORE the fee moved off the pool. At the
  // time the graduated pool charged v4's own LP fee, which v4 always takes from the swap's
  // INPUT — so this sell paid its fee in the launch token. The hook charges POOL_FEE_BPS
  // itself now, denominated in quote, which for a sell means off the OUTPUT. The reserves,
  // the stack and the impact story are unchanged and are what this block exists to guard;
  // the fill is therefore asserted against the input-fee branch that actually produced it.
  it("reproduces the pool's real fill for a majority-impact exit (input-fee model)", () => {
    const out = clmmAmountOut(FULL_STACK, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, true);
    // Within 0.1% of the on-chain result — a finite tick range is not precisely xy=k.
    const diff = out > ACTUAL_FILL ? out - ACTUAL_FILL : ACTUAL_FILL - out;
    expect(Number((diff * 10_000n) / ACTUAL_FILL)).toBeLessThan(10); // < 0.1%
    expect(out).toBeLessThanOrEqual(ACTUAL_FILL); // never overstate: the bound derives from it
  });

  it("takes a sell's fee off the output, which pays strictly less than the input model", () => {
    const sell = clmmAmountOut(FULL_STACK, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, false);
    const asInputFee = clmmAmountOut(FULL_STACK, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, true);
    // `(1-f)·Qa/(T+a)` vs `Q(1-f)a/(T+(1-f)a)`: the ratio is `(T+(1-f)a)/(T+a) <= 1`, so
    // charging after impact always pays less. Equal only at f = 0.
    expect(sell).toBeLessThan(asInputFee);
    expect(clmmAmountOut(FULL_STACK, T_RESERVE, Q_RESERVE, 0n, false)).toBe(
      clmmAmountOut(FULL_STACK, T_RESERVE, Q_RESERVE, 0n, true),
    );
  });

  it("a 5% bound off this estimate is satisfiable, unlike one off spot", () => {
    const est = clmmAmountOut(FULL_STACK, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, false);
    expect((est * 9500n) / 10_000n).toBeLessThanOrEqual(est);

    // The old behaviour, for contrast: spot × amountIn ignores impact entirely.
    const POOL_PRICE_WAD = 4375845553n; // hook.poolPriceWad(pid)
    const spotEst = (FULL_STACK * POOL_PRICE_WAD) / 10n ** 18n;
    expect((spotEst * 9500n) / 10_000n).toBeGreaterThan(est); // unreachable
  });

  it("converges on spot as the trade shrinks relative to depth", () => {
    const tiny = T_RESERVE / 100_000n; // 0.001% of depth
    for (const quoteIsInput of [true, false]) {
      const out = clmmAmountOut(tiny, T_RESERVE, Q_RESERVE, 0n, quoteIsInput);
      const spot = (tiny * Q_RESERVE) / T_RESERVE;
      const diff = spot > out ? spot - out : out - spot;
      expect(Number((diff * 1_000_000n) / spot)).toBeLessThan(100); // < 0.01%
    }
  });

  it("charges the fee in both directions", () => {
    for (const quoteIsInput of [true, false]) {
      const withFee = clmmAmountOut(10n ** 24n, T_RESERVE, Q_RESERVE, 100n, quoteIsInput);
      const noFee = clmmAmountOut(10n ** 24n, T_RESERVE, Q_RESERVE, 0n, quoteIsInput);
      expect(withFee).toBeLessThan(noFee);
    }
  });

  it("returns 0 rather than dividing by zero on an empty reserve", () => {
    for (const quoteIsInput of [true, false]) {
      expect(clmmAmountOut(10n ** 18n, 0n, Q_RESERVE, 100n, quoteIsInput)).toBe(0n);
      expect(clmmAmountOut(10n ** 18n, T_RESERVE, 0n, 100n, quoteIsInput)).toBe(0n);
      expect(clmmAmountOut(0n, T_RESERVE, Q_RESERVE, 100n, quoteIsInput)).toBe(0n);
    }
  });

  // The exact-out inverse. Pinned by round-tripping through clmmAmountOut, so the two
  // stay each other's inverses: paying the quoted input must produce at least the
  // wanted output, with only rounding-and-gross-up slack above it.
  describe("clmmAmountIn — exact-out inverse", () => {
    it("buy: the quoted input buys at least the wanted tokens, with no real overshoot", () => {
      const want = T_RESERVE / 50n; // 2% of depth
      const inv = clmmAmountIn(want, Q_RESERVE, T_RESERVE, POOL_FEE_BPS, true)!;
      const out = clmmAmountOut(inv.amountIn, Q_RESERVE, T_RESERVE, POOL_FEE_BPS, true);
      expect(out >= want).toBe(true);
      expect(Number(((out - want) * 1_000_000n) / want)).toBeLessThan(100); // < 0.01% slack
    });

    it("sell: the quoted tokens net at least the wanted quote, with no real overshoot", () => {
      const want = Q_RESERVE / 50n;
      const inv = clmmAmountIn(want, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, false)!;
      const out = clmmAmountOut(inv.amountIn, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, false);
      expect(out >= want).toBe(true);
      expect(Number(((out - want) * 1_000_000n) / want)).toBeLessThan(100);
    });

    it("charges the fee on the hook's side of each direction", () => {
      const wantTokens = T_RESERVE / 100n;
      const buy = clmmAmountIn(wantTokens, Q_RESERVE, T_RESERVE, POOL_FEE_BPS, true)!;
      // Buy: fee sits on top of the pool's required input — f/(1−f) of it, grossed up.
      const poolIn = buy.amountIn - buy.feeQuote;
      expect(buy.feeQuote).toBe(grossUpForFee(poolIn, POOL_FEE_BPS) - poolIn);

      const wantQuote = Q_RESERVE / 100n;
      const sell = clmmAmountIn(wantQuote, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, false)!;
      // Sell: the pool must produce the grossed-up output; the hook keeps the difference.
      expect(sell.feeQuote).toBe(grossUpForFee(wantQuote, POOL_FEE_BPS) - wantQuote);

      // Zero fee: both collapse to the pure constant-product inverse.
      expect(clmmAmountIn(wantTokens, Q_RESERVE, T_RESERVE, 0n, true)!.feeQuote).toBe(0n);
      expect(clmmAmountIn(wantQuote, T_RESERVE, Q_RESERVE, 0n, false)!.feeQuote).toBe(0n);
    });

    it("returns null when the pool cannot produce the wanted output", () => {
      // A constant product can never pay out its whole reserve.
      expect(clmmAmountIn(T_RESERVE, Q_RESERVE, T_RESERVE, POOL_FEE_BPS, true)).toBeNull();
      expect(clmmAmountIn(Q_RESERVE, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, false)).toBeNull();
      // A sell must clear the reserve AFTER grossing up for the fee, so it turns null
      // strictly before the raw reserve is asked for.
      const nearAll = (Q_RESERVE * (BPS - POOL_FEE_BPS)) / BPS + 1n;
      expect(clmmAmountIn(nearAll, T_RESERVE, Q_RESERVE, POOL_FEE_BPS, false)).toBeNull();
      // Empty reserves cannot serve anything.
      expect(clmmAmountIn(10n ** 18n, 0n, T_RESERVE, POOL_FEE_BPS, true)).toBeNull();
      expect(clmmAmountIn(10n ** 18n, Q_RESERVE, 0n, POOL_FEE_BPS, true)).toBeNull();
    });

    it("treats a non-positive want as free rather than as unfillable", () => {
      expect(clmmAmountIn(0n, Q_RESERVE, T_RESERVE, POOL_FEE_BPS, true)).toEqual({
        amountIn: 0n,
        feeQuote: 0n,
      });
    });
  });
});

describe("stored token reserve", () => {
  it("prefers the stored y and falls back to the K/X(b) reconstruction", () => {
    const b = B / 3n;
    const stored = reserveY(curve, b) + 12_345n;
    expect(curveTokenReserve(curve, b, stored)).toBe(stored);
    expect(curveTokenReserve(curve, b, undefined)).toBe(reserveY(curve, b));
    // Zero is treated as "not supplied": an adapted row that carries no token leg must
    // not be read as an empty curve, which would price a sell at the whole quote reserve.
    expect(curveTokenReserve(curve, b, 0n)).toBe(reserveY(curve, b));
  });

  it("keeps `S - y` exactly equal to the circulating supply across a sequence", () => {
    // Mirrors the Solidity fuzz: the contract stores both reserves and moves each by the
    // exact amount traded, so the SDK must too. Reconstructing y from b instead drifted a
    // fraction of a whole token per sell, which is what made Sell Max unpriceable.
    let b = 0n;
    let y = S;
    let held = 0n;

    const buy = (gross: bigint) => {
      const p = previewBuy(curve, b, y, gross, 0n, 30n);
      b += gross;
      y -= p.amountOut;
      held += p.amountOut;
    };
    const sell = (tokens: bigint) => {
      const p = previewSell(curve, b, y, tokens, 0n);
      b -= p.amountOut + p.feeQuote;
      y += tokens;
      held -= tokens;
    };

    buy(10n ** 18n);
    expect(S - y).toBe(held);
    sell(held / 4n);
    expect(S - y).toBe(held);
    buy(5n * 10n ** 17n);
    expect(S - y).toBe(held);
    sell(held / 3n);
    expect(S - y).toBe(held);

    // Sell Max is priceable and never asks for more than the curve holds.
    const finalSell = previewSell(curve, b, y, held, 0n);
    expect(finalSell.amountOut).toBeGreaterThan(0n);
    expect(finalSell.amountOut + finalSell.feeQuote).toBeLessThanOrEqual(b);
  });

  it("prices a full-balance sell strictly below the bonded reserve", () => {
    // The old reconstruction let a holder accumulate tokens the curve would price above
    // `b`; with the pair, the whole holdable balance always fits inside it.
    const gross = 2n * 10n ** 18n;
    const bought = previewBuy(curve, 0n, S, gross, 100n, 30n);
    const b = gross - bought.feeQuote;
    const y = S - bought.amountOut;
    const exit = previewSell(curve, b, y, bought.amountOut, 100n);
    expect(exit.amountOut + exit.feeQuote).toBeLessThanOrEqual(b);
    expect(exit.amountOut).toBeGreaterThan(0n);
  });
});
