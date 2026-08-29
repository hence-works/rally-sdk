/**
 * PROTOCOL v2 curve math.
 *
 * The end-to-end fixture below is not hand-computed. It was captured from a real
 * `RallyHookV2` on a local anvil: deploy, launch a coin, read `positionsOf`, then buy 1
 * wETH through `RallyRouter` and record what the pool actually paid out. The assertion is
 * that `simulateSwap` reproduces that fill to the wei, which is the only claim that
 * matters here — an off-chain quote that is close is a quote that reverts on `minOut`.
 */
import { describe, expect, it } from "vitest";
import { quoteTrade, quoteTradeExactOut } from "../src/trade";
import type { CurveParams, LaunchState } from "../src/types";
import {
  amount0Delta,
  amount1Delta,
  ladderAmount,
  liquidityAt,
  simulateSwap,
  sqrtPriceAtTick,
  tickMapOf,
  type LadderPosition,
} from "../src/clmm";

describe("sqrtPriceAtTick", () => {
  // Uniswap's own published values. The two middle ones are also the constants
  // `trade.ts` has hardcoded for LaunchLib's usable extremes, so this pins both.
  it.each([
    [0, 79228162514264337593543950336n],
    [-887272, 4295128739n],
    [887272, 1461446703485210103287273052203988822378723970342n],
    [-887220, 4306310044n],
    [887220, 1457652066949847389969617340386294118487833376468n],
  ])("matches TickMath at tick %i", (tick, expected) => {
    expect(sqrtPriceAtTick(tick)).toBe(expected);
  });

  it("is monotonic and rejects out-of-range ticks", () => {
    expect(sqrtPriceAtTick(60)).toBeGreaterThan(sqrtPriceAtTick(0));
    expect(sqrtPriceAtTick(-60)).toBeLessThan(sqrtPriceAtTick(0));
    expect(() => sqrtPriceAtTick(887273)).toThrow();
  });
});

/** The ladder a shipped FLAT preset actually mints, read off the deployed hook. */
const LADDER: LadderPosition[] = [
  { tickLower: -205020, tickUpper: -172800, liquidity: 35304984944960226678912n },
  { tickLower: -172800, tickUpper: 887220, liquidity: 35481665932094934394493n },
];
const OPEN = sqrtPriceAtTick(LADDER[0]!.tickLower);

describe("ladderAmount", () => {
  it("is zero quote at the opening price: the curve is entirely launch token", () => {
    // Matches `hook.bondedOf` at launch, which is why v2 emits `Bonded` once with 0.
    expect(ladderAmount(LADDER, OPEN, false)).toBe(0n);
  });

  it("holds only quote once the price is above the whole ladder", () => {
    const top = sqrtPriceAtTick(887220);
    expect(ladderAmount(LADDER, top, true)).toBe(0n);
    expect(ladderAmount(LADDER, top, false)).toBeGreaterThan(0n);
  });

  it("is monotonic in price", () => {
    const a = ladderAmount(LADDER, sqrtPriceAtTick(-190000), false);
    const b = ladderAmount(LADDER, sqrtPriceAtTick(-180000), false);
    expect(b).toBeGreaterThan(a);
  });
});

describe("tickMapOf / liquidityAt", () => {
  it("nets each boundary rather than listing positions", () => {
    // Two abutting ranges share the tick at -172800: one ends there and the next begins,
    // so the boundary carries their DIFFERENCE, not either liquidity. Getting this wrong
    // is how a simulation ends up trading against the wrong depth past the first range.
    const map = tickMapOf(LADDER);
    expect(map.map((t) => t.tick)).toEqual([-205020, -172800, 887220]);
    expect(map[1]!.net).toBe(LADDER[1]!.liquidity - LADDER[0]!.liquidity);
    // -180000 sits inside the FIRST range [-205020, -172800); the second only begins
    // above it.
    expect(liquidityAt(LADDER, sqrtPriceAtTick(-180000))).toBe(LADDER[0]!.liquidity);
    expect(liquidityAt(LADDER, sqrtPriceAtTick(-100000))).toBe(LADDER[1]!.liquidity);
  });

  it("drops a boundary whose net really is zero", () => {
    const abutting: LadderPosition[] = [
      { tickLower: -1200, tickUpper: 0, liquidity: 100n },
      { tickLower: 0, tickUpper: 1200, liquidity: 100n },
    ];
    expect(tickMapOf(abutting).map((t) => t.tick)).toEqual([-1200, 1200]);
  });

  it("sums nested positions", () => {
    const nested: LadderPosition[] = [
      { tickLower: -1200, tickUpper: 1200, liquidity: 100n },
      { tickLower: -600, tickUpper: 600, liquidity: 50n },
    ];
    expect(liquidityAt(nested, sqrtPriceAtTick(0))).toBe(150n);
    expect(liquidityAt(nested, sqrtPriceAtTick(900))).toBe(100n);
  });
});

describe("amount deltas", () => {
  it("round in opposite directions", () => {
    const a = sqrtPriceAtTick(0);
    const b = sqrtPriceAtTick(600);
    expect(amount0Delta(a, b, 10n ** 18n, true)).toBeGreaterThanOrEqual(
      amount0Delta(a, b, 10n ** 18n, false),
    );
    expect(amount1Delta(a, b, 10n ** 18n, true)).toBeGreaterThanOrEqual(
      amount1Delta(a, b, 10n ** 18n, false),
    );
  });

  it("is symmetric in its price arguments", () => {
    const a = sqrtPriceAtTick(-600);
    const b = sqrtPriceAtTick(600);
    expect(amount1Delta(a, b, 1n << 64n, false)).toBe(amount1Delta(b, a, 1n << 64n, false));
  });
});

describe("simulateSwap against a live fill", () => {
  // Captured from anvil: 1 wETH in at the 99% anti-snipe rate, so the curve saw 0.01
  // wETH. The fee is applied by the CALLER (the pool charges it on a buy), which is why
  // the simulation is handed the net figure.
  const NET_IN = 10_000_000_000_000_000n; // 1 ETH less the 99% opening fee
  const ACTUAL_OUT = 7_943_161_311_662_721_107_263_987n;
  const ACTUAL_POST_SQRT = 2_822_385_631_707_875_283_813_405n;

  it("reproduces the fill to the wei", () => {
    // Buy: quote is currency1, token is currency0, so the price moves UP.
    const r = simulateSwap(LADDER, OPEN, false, NET_IN, true);
    expect(r.amountOut).toBe(ACTUAL_OUT);
    expect(r.sqrtPriceX96).toBe(ACTUAL_POST_SQRT);
    expect(r.exhausted).toBe(false);
  });

  it("agrees with bondedOf after the fill", () => {
    // The hook reported 9999999999999999 bonded after this trade.
    const r = simulateSwap(LADDER, OPEN, false, NET_IN, true);
    expect(ladderAmount(LADDER, r.sqrtPriceX96, false)).toBe(9_999_999_999_999_999n);
  });

  it("quotes exact-output as the inverse of exact-input", () => {
    const inTo = simulateSwap(LADDER, OPEN, false, NET_IN, true);
    const out = simulateSwap(LADDER, OPEN, false, inTo.amountOut, false);
    // Exact-out rounds the input UP, so it asks for at most a wei more than exact-in
    // consumed. Anything larger would mean the two directions disagree about the curve.
    expect(out.amountIn - inTo.amountIn).toBeGreaterThanOrEqual(0n);
    expect(out.amountIn - inTo.amountIn).toBeLessThanOrEqual(1n);
  });

  it("round trips: selling the tokens back walks the price down again", () => {
    const buy = simulateSwap(LADDER, OPEN, false, NET_IN, true);
    const sell = simulateSwap(LADDER, buy.sqrtPriceX96, true, buy.amountOut, true);
    expect(sell.sqrtPriceX96).toBeLessThanOrEqual(buy.sqrtPriceX96);
    // A round trip never returns more quote than it paid in, fees aside.
    expect(sell.amountOut).toBeLessThanOrEqual(NET_IN);
  });

  it("walks past the first range into the second", () => {
    // Exactly the quote the ladder holds at the -172800 boundary, plus a margin, so the
    // swap has to cross it and pick up the second range's depth. If the boundary's NET
    // liquidity were mishandled, this is the assertion that moves.
    const toBoundary = ladderAmount(LADDER, sqrtPriceAtTick(-172800), false);
    const big = simulateSwap(LADDER, OPEN, false, toBoundary + 10n ** 18n, true);
    expect(big.sqrtPriceX96).toBeGreaterThan(sqrtPriceAtTick(-172800));
    expect(big.exhausted).toBe(false);
    // The walk and the direct valuation of the ladder agree at the resulting price,
    // within the per-position truncation each does independently.
    const walked = ladderAmount(LADDER, big.sqrtPriceX96, false);
    const drift = walked > big.amountIn ? walked - big.amountIn : big.amountIn - walked;
    expect(drift).toBeLessThanOrEqual(BigInt(LADDER.length));
  });

  it("reports exhaustion rather than inventing liquidity", () => {
    // A bounded ladder, since the shipped one tops out at tick 887220 and would absorb
    // more quote than exists. Asking for more than it holds must say so, not fabricate.
    const bounded: LadderPosition[] = [
      { tickLower: -1200, tickUpper: 1200, liquidity: 10n ** 18n },
    ];
    const start = sqrtPriceAtTick(-1200);
    const capacity = ladderAmount(bounded, sqrtPriceAtTick(1200), false);
    const r = simulateSwap(bounded, start, false, capacity * 2n, true);
    expect(r.exhausted).toBe(true);
    expect(r.amountIn).toBeLessThanOrEqual(capacity + 1n);
    expect(r.sqrtPriceX96).toBe(sqrtPriceAtTick(1200));
  });
});

/**
 * `quoteTrade` on a v2 launch. The fixture is the same live one, so the BUY assertion is
 * the anvil fill end to end: 1 wETH in at the 99% opening rate produced exactly these
 * tokens through the real router.
 */
describe("quoteTrade on a v2 launch", () => {
  const PARAMS: CurveParams = {
    totalSupply: 1_000_000_000n * 10n ** 18n,
    curveAllocation: 800_000_000n * 10n ** 18n,
    feeStartBps: 9_900n,
    feeEndBps: 100n,
    feeDecaySeconds: 30n,
    poolFeeBps: 100n,
  };
  const LAUNCHED_AT = 1_700_000_000;

  const v2Launch = (over: Partial<LaunchState> = {}): LaunchState =>
    ({
      token: "0x1f602adb901ed00d2c88bbeb2fb44791c1bb180b",
      pid: "0x00",
      protocolVersion: 2,
      quote: {
        address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        allowed: true,
        decimals: 18,
        gradThreshold: 15_000n * 10n ** 18n,
        launchFee: 0n,
        scale: 10n ** 18n,
      },
      phase: "CURVE",
      bonded: 0n,
      gradThreshold: 15_000n * 10n ** 18n,
      launchedAt: LAUNCHED_AT,
      graduatedAt: 0,
      poolPriceWad: 1n,
      reserves: { quote: 0n, token: 0n },
      feeSplit: { creatorBps: 4000, dividendBps: 0, buybackBps: 4000, lpSupportBps: 2000 },
      // Token is currency0, quote is currency1 (I-7 forces the token to sort below).
      quoteIsCurrency0: false,
      poolKey: {} as never,
      hook: "0x8021C0ddE411301f034Bc31DD85221D16F5Ee8cC",
      router: "0xf5059a5D33d5853360D16C683c16e67980206f36",
      paramRegistry: "0x09635F643e140090A9A8Dcd712eD6285858ceBef",
      sqrtPriceX96: OPEN,
      tick: -205020,
      ladder: LADDER,
      ...over,
    }) as LaunchState;

  it("reproduces the live buy, fee included", () => {
    // At t=0 the anti-snipe rate is the full 99%, which is what anvil charged.
    const q = quoteTrade(v2Launch(), PARAMS, {
      side: "buy",
      amountIn: 10n ** 18n,
      atTime: LAUNCHED_AT,
    });
    expect(q.feeBps).toBe(9_900n);
    expect(q.feeQuote).toBe(990_000_000_000_000_000n);
    expect(q.amountOut).toBe(7_943_161_311_662_721_107_263_987n);
    expect(q.exact).toBe(true);
  });

  it("takes the fee off the OUTPUT on a sell, not the input", () => {
    // The pool is forced to charge nothing on a sell; the hook takes its cut off the
    // quote produced. So the whole input reaches the curve and the output is net.
    const buy = quoteTrade(v2Launch(), PARAMS, {
      side: "buy",
      amountIn: 10n ** 18n,
      atTime: LAUNCHED_AT,
    });
    const after = simulateSwap(LADDER, OPEN, false, 10n ** 18n - buy.feeQuote, true);
    const sell = quoteTrade(
      v2Launch({ sqrtPriceX96: after.sqrtPriceX96, phase: "CURVE" }),
      PARAMS,
      { side: "sell", amountIn: buy.amountOut, atTime: LAUNCHED_AT + 3600 },
    );
    // Past the decay window the rate is the floor.
    expect(sell.feeBps).toBe(100n);
    const gross = sell.amountOut + sell.feeQuote;
    expect(sell.feeQuote).toBe((gross * 100n) / 10_000n);
    // A round trip cannot return more than went in.
    expect(sell.amountOut).toBeLessThan(10n ** 18n);
  });

  it("prices a graduated pool through the same ladder, at the flat fee", () => {
    const q = quoteTrade(v2Launch({ phase: "GRADUATED", graduatedAt: LAUNCHED_AT + 60 }), PARAMS, {
      side: "buy",
      amountIn: 10n ** 18n,
      atTime: LAUNCHED_AT + 3600,
    });
    // No curve/pool branch in v2: graduation is a latch, so the same liquidity prices it.
    expect(q.feeBps).toBe(PARAMS.poolFeeBps);
    expect(q.exact).toBe(true);
    expect(q.amountOut).toBeGreaterThan(0n);
  });

  it("refuses to price a v2 launch whose ladder was not read", () => {
    expect(() =>
      quoteTrade(v2Launch({ ladder: undefined }), PARAMS, { side: "buy", amountIn: 1n }),
    ).toThrow(/position ladder was not read/);
  });

  it("exact-out inverts exact-in", () => {
    const wanted = 1_000_000n * 10n ** 18n;
    const cost = quoteTradeExactOut(v2Launch(), PARAMS, {
      side: "buy",
      amountOut: wanted,
      atTime: LAUNCHED_AT,
    });
    const back = quoteTrade(v2Launch(), PARAMS, {
      side: "buy",
      amountIn: cost.amountIn,
      atTime: LAUNCHED_AT,
    });
    expect(back.amountOut).toBeGreaterThanOrEqual(wanted);
  });
});
