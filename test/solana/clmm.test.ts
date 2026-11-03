import { describe, expect, it } from "vitest";
import vectors from "./golden/vectors/rust-vectors.json";
import {
  MAX_SQRT_PRICE_X64,
  MAX_TICK,
  MIN_SQRT_PRICE_X64,
  MIN_TICK,
  Q64,
  amount0Delta,
  amount1Delta,
  amountsForLiquidity,
  computeSwapStep,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  liquidityFromAmount0,
  liquidityFromAmount1,
} from "../../src/solana/clmm";

describe("tick math: Raydium's own tests (tick_math.rs)", () => {
  it("min and max tick map to the pool's bounds, and the price at tick 0 is exactly 1", () => {
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE_X64);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE_X64);
    expect(getSqrtPriceAtTick(0)).toBe(Q64);
    expect(getTickAtSqrtPrice(MIN_SQRT_PRICE_X64)).toBe(MIN_TICK);
    // The max price can never be reached: the last tick below it is MAX_TICK - 1.
    expect(getTickAtSqrtPrice(MAX_SQRT_PRICE_X64 - 1n)).toBe(MAX_TICK - 1);
  });

  it("rejects a tick or price outside the range", () => {
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow();
    expect(() => getSqrtPriceAtTick(MIN_TICK - 1)).toThrow();
    expect(() => getSqrtPriceAtTick(1.5)).toThrow();
    expect(() => getTickAtSqrtPrice(MIN_SQRT_PRICE_X64 - 1n)).toThrow();
    expect(() => getTickAtSqrtPrice(MAX_SQRT_PRICE_X64)).toThrow();
  });

  it("tick_round_down: the tick of a price is the greatest tick at or below it", () => {
    for (const t of [-28861, 28861]) {
      const p = getSqrtPriceAtTick(t);
      expect(getTickAtSqrtPrice(p)).toBe(t);
      expect(getTickAtSqrtPrice(p + 1n)).toBe(t);
      expect(getTickAtSqrtPrice(getSqrtPriceAtTick(t + 1) - 1n)).toBe(t);
      expect(getTickAtSqrtPrice(p - 1n)).toBe(t - 1);
    }
  });

  it("round-trips every 7th tick and every tick near both bounds and zero (Raydium's test is exhaustive)", () => {
    const check = (t: number) => expect(getTickAtSqrtPrice(getSqrtPriceAtTick(t))).toBe(t);
    for (let t = MIN_TICK; t < MAX_TICK; t += 7) check(t);
    for (let t = MIN_TICK; t < MIN_TICK + 500; t++) check(t);
    for (let t = MAX_TICK - 500; t < MAX_TICK; t++) check(t);
    for (let t = -500; t < 500; t++) check(t);
  });

  it("is strictly increasing in the tick", () => {
    let prev = 0n;
    for (let t = -5000; t <= 5000; t++) {
      const p = getSqrtPriceAtTick(t);
      expect(p > prev).toBe(true);
      prev = p;
    }
  });
});

describe("matches the Rally program's own Rust (golden/vectors/main.rs)", () => {
  it("sqrt price at tick", () => {
    for (const [tick, sqrt] of vectors.sqrt) expect(getSqrtPriceAtTick(tick as number)).toBe(BigInt(sqrt as string));
  });

  it("tick at sqrt price", () => {
    for (const [sqrt, tick] of vectors.tick) expect(getTickAtSqrtPrice(BigInt(sqrt as string))).toBe(tick);
  });

  it("liquidity from amounts, and position amounts rounded both ways", () => {
    const a = getSqrtPriceAtTick(-107640);
    const b = getSqrtPriceAtTick(-75360);
    const p = getSqrtPriceAtTick(-100000);
    expect(liquidityFromAmount0(a, b, 799861436269360n)).toBe(BigInt(vectors.L0!));
    expect(liquidityFromAmount1(a, b, 85000000000n)).toBe(BigInt(vectors.L1!));
    for (const v of vectors.delta) {
      const l = BigInt(v.liquidity);
      if (v.kind === "D0") expect(amount0Delta(a, b, l, v.roundUp)).toBe(BigInt(v.value!));
      if (v.kind === "D1") expect(amount1Delta(a, b, l, v.roundUp)).toBe(BigInt(v.value!));
      if (v.kind === "AFL") {
        const r = amountsForLiquidity(p, a, b, l, v.roundUp);
        expect([r.amount0, r.amount1]).toEqual([BigInt(v.amount0!), BigInt(v.amount1!)]);
      }
    }
  });
});

describe("swap step", () => {
  const L = 4_593_921_074_891n;
  const lo = getSqrtPriceAtTick(-107640);
  const hi = getSqrtPriceAtTick(-75360);
  const mid = getSqrtPriceAtTick(-100000);

  it("a buy that stops short of its target charges input + fee == the whole remaining input", () => {
    const s = computeSwapStep(mid, hi, L, 1_000_000_000n, 2500n, false, true);
    expect(s.sqrtPriceNextX64).toBeLessThan(hi);
    expect(s.amountIn + s.feeAmount).toBe(1_000_000_000n);
    expect(s.feeAmount).toBeGreaterThan(0n);
  });

  it("a buy that reaches its target consumes exactly the amount to the target plus a ceil'd fee, and leaves the rest", () => {
    const s = computeSwapStep(mid, hi, L, 10n ** 15n, 2500n, false, true);
    expect(s.sqrtPriceNextX64).toBe(hi);
    expect(s.amountIn + s.feeAmount).toBeLessThan(10n ** 15n);
    expect(s.feeAmount).toBe((s.amountIn * 2500n + 997_499n) / 997_500n);
  });

  it("a sell takes the fee off its quote output, rounded up, and the taker keeps the rest", () => {
    const s = computeSwapStep(mid, lo, L, 123_456_789_012n, 2500n, true, false);
    const grossOut = amount1Delta(s.sqrtPriceNextX64, mid, L, false);
    expect(s.feeAmount).toBe((grossOut * 2500n + 999_999n) / 1_000_000n);
    expect(s.amountOut).toBe(grossOut - s.feeAmount);
    expect(s.amountIn).toBe(123_456_789_012n);
  });

  it("with no fee, buy then sell at the same liquidity cannot return more than was paid", () => {
    for (const amt of [1_000n, 77_777n, 1_000_003n, 999_999_999n]) {
      const buy = computeSwapStep(mid, hi, L, amt, 0n, false, true);
      const sell = computeSwapStep(buy.sqrtPriceNextX64, lo, L, buy.amountOut, 0n, true, false);
      expect(sell.amountOut <= amt).toBe(true);
    }
  });
});
