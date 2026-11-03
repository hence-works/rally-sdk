import { describe, expect, it } from "vitest";
import vectors from "./golden/vectors/rust-vectors.json";
import { getSqrtPriceAtTick, amountsForLiquidity } from "../../src/solana/clmm";
import { alignTick, buildCurve, curveTicks, planFirstBuy, presetSegments, sqrtPriceAfterBuy } from "../../src/solana/curve";
import { quoteFirstBuy } from "../../src/solana";
import { launchFixture } from "./fixtures";

const S = 1_000_000_000_000_000n; // 1e9 tokens at 6dp
const B: Record<string, bigint> = { sol: 85_000_000_000n, usdc: 15_000_000_000n };
const build = (preset: number, quote: string) =>
  buildCurve({ segments: presetSegments(preset), totalSupply: S, curveAllocationBps: 8000, gradThreshold: B[quote]!, tailBps: 10_000 });

describe("buildCurve equals the program's build_curve (Rust vectors)", () => {
  for (const c of vectors.curves) {
    it(`preset ${c.preset} on ${c.quote}`, () => {
      const l = build(c.preset, c.quote);
      expect([l.tickLower, l.tickUpper]).toEqual([c.tickLower, c.tickUpper]);
      expect(l.curveSupply).toBe(BigInt(c.curveSupply));
      expect(l.tailSupply).toBe(BigInt(c.tailSupply));
      expect(l.positions.map((p) => [p.tickLower, p.tickUpper, p.liquidity.toString()])).toEqual(c.positions);
    });
  }

  it("also equals the Launch the deployed program created on devnet for the smoke coin", () => {
    // LV75z5nv...: preset 0 on wSOL. Ticks, supply split and both positions as stored on chain.
    const l = build(0, "sol");
    expect([l.tickLower, l.tickUpper, l.curveSupply, l.tailSupply]).toEqual([-107640, -75360, 799861436269361n, 200138563730639n]);
    expect(l.positions.map((p) => p.liquidity)).toEqual([4593921074891n, 4623714252059n]);
  });
});

describe("sqrtPriceAfterBuy equals the program's (Rust vectors)", () => {
  for (const v of vectors.buys) {
    it(`preset ${v.preset} ${v.quote}: ${v.tokens} tokens`, () => {
      const l = build(v.preset, v.quote);
      if (v.sqrt === null) {
        expect(() => sqrtPriceAfterBuy(l.positions, l.tickLower, BigInt(v.tokens))).toThrow();
      } else {
        expect(sqrtPriceAfterBuy(l.positions, l.tickLower, BigInt(v.tokens))).toBe(BigInt(v.sqrt));
      }
    });
  }
});

describe("planFirstBuy", () => {
  it("the deposit delta is within a few units of the request (the program's own test)", () => {
    const l = build(1, "sol");
    const start = getSqrtPriceAtTick(l.tickLower);
    for (const want of [1n, 1_000_000n, S / 100n, S / 10n]) {
      const plan = planFirstBuy(l.positions, l.tickLower, l.tickUpper, want);
      let removed = 0n;
      for (const p of l.positions) {
        const lo = getSqrtPriceAtTick(p.tickLower);
        const hi = getSqrtPriceAtTick(p.tickUpper);
        const at0 = amountsForLiquidity(start, lo, hi, p.liquidity, false).amount0;
        const at1 = amountsForLiquidity(plan.sqrtPriceOpenX64, lo, hi, p.liquidity, true).amount0;
        removed += at0 > at1 ? at0 - at1 : 0n;
      }
      expect(removed + 8n >= want && removed <= want + 8n).toBe(true);
      expect(plan.tokensOut <= want).toBe(true);
    }
  });

  it("no first buy costs nothing and opens at P(0)", () => {
    const l = build(0, "sol");
    const plan = planFirstBuy(l.positions, l.tickLower, l.tickUpper, 0n);
    expect(plan.quoteCost).toBe(0n);
    expect(plan.tokensOut).toBe(0n);
    expect(plan.sqrtPriceOpenX64).toBe(plan.sqrtPriceStartX64);
  });

  it("a first buy that would take the whole curve is refused, never clamped", () => {
    const l = build(0, "sol");
    expect(() => planFirstBuy(l.positions, l.tickLower, l.tickUpper, l.curveSupply)).toThrow();
    expect(() => planFirstBuy(l.positions, l.tickLower, l.tickUpper, S)).toThrow();
  });

  it("cost is monotonic in the tokens bought", () => {
    const l = build(2, "sol");
    let prev = -1n;
    for (const want of [0n, 1n, 10n ** 6n, 10n ** 9n, 10n ** 12n, 10n ** 13n, 2n * 10n ** 13n]) {
      const c = planFirstBuy(l.positions, l.tickLower, l.tickUpper, want).quoteCost;
      expect(c >= prev).toBe(true);
      prev = c;
    }
  });
});

describe("quoteFirstBuy", () => {
  const cfg = { totalSupply: S, curveAllocationBps: 8000, tailBps: 10_000, firstBuySupplyCapBps: 200, gradThreshold: 85_000_000_000n };

  it("quotes before create_launch from the preset and the governed parameters", async () => {
    const q = await quoteFirstBuy({ ...cfg, curvePreset: 0, firstBuyTokens: S / 100n });
    // The same numbers the live program charged for this first buy (test/solana/golden).
    expect(q.quoteCost).toBe(213_726_508n);
    expect(q.tokensOut).toBe(9_999_999_999_999n);
    expect(q.maxFirstBuyQuote).toBe(q.quoteCost);
  });

  it("agrees with quoting from the created Launch's own positions", async () => {
    const l = build(0, "sol");
    const launch = launchFixture({
      phase: "Created",
      pool: "11111111111111111111111111111111" as never,
      tickLower: l.tickLower,
      tickUpper: l.tickUpper,
      numPositions: l.positions.length,
      positions: [
        ...l.positions.map((p) => ({ nftMint: "11111111111111111111111111111111" as never, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity, feeNftMint: "11111111111111111111111111111111" as never })),
        ...Array.from({ length: 6 - l.positions.length }, () => ({ nftMint: "11111111111111111111111111111111" as never, tickLower: 0, tickUpper: 0, liquidity: 0n, feeNftMint: "11111111111111111111111111111111" as never })),
      ],
      firstBuyTokens: S / 100n,
    });
    const a = await quoteFirstBuy({ launch });
    const b = await quoteFirstBuy({ ...cfg, firstBuyTokens: S / 100n });
    expect([a.quoteCost, a.tokensOut, a.sqrtPriceOpenX64]).toEqual([b.quoteCost, b.tokensOut, b.sqrtPriceOpenX64]);
  });

  it("enforces the governed first-buy cap when it is known", async () => {
    await expect(quoteFirstBuy({ ...cfg, firstBuyTokens: S / 100n + S / 100n + 1n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(quoteFirstBuy({ ...cfg, firstBuyTokens: S / 50n })).resolves.toBeTruthy();
  });

  it("asks for what it cannot read instead of guessing", async () => {
    await expect(quoteFirstBuy({ firstBuyTokens: 1n })).rejects.toMatchObject({ code: "MISSING_ADDRESS" });
    await expect(quoteFirstBuy({ totalSupply: S, curveAllocationBps: 8000, tailBps: 10_000, firstBuyTokens: 1n })).rejects.toMatchObject({ code: "MISSING_ADDRESS" });
    await expect(quoteFirstBuy({ ...cfg, curvePreset: 7, firstBuyTokens: 1n })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("rejects shapes the program would reject", () => {
    expect(() => buildCurve({ segments: [], totalSupply: S, curveAllocationBps: 8000, gradThreshold: 85_000_000_000n, tailBps: 10_000 })).toThrow();
    expect(() =>
      buildCurve({ segments: [{ startBps: 0, endBps: 9000, numPositions: 1, sharesBps: 10000, anchorAtFar: true }], totalSupply: S, curveAllocationBps: 8000, gradThreshold: 85_000_000_000n, tailBps: 10_000 }),
    ).toThrow();
  });
});

describe("curveTicks / alignTick", () => {
  it("snaps to the grid like the program", () => {
    expect(alignTick(true, -61, 60)).toBe(-120);
    expect(alignTick(false, -61, 60)).toBe(-60);
    expect(alignTick(true, 61, 60)).toBe(60);
    expect(alignTick(false, 61, 60)).toBe(120);
    expect(alignTick(false, 60, 60)).toBe(60);
    expect(alignTick(true, -60, 60)).toBe(-60);
  });

  it("a flat curve spans a 25x range, plus up to two spacings of snapping", () => {
    for (const b of [85_000_000_000n, 15_000_000_000n]) {
      const [lo, hi] = curveTicks(S, (S / 10n) * 8n, b, 60);
      expect(hi - lo >= 32_190 && hi - lo <= 32_190 + 120).toBe(true);
    }
  });
});
