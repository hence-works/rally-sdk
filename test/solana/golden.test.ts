import { describe, expect, it } from "vitest";
import { quoteBuySolana, quoteFirstBuy, quoteSellSolana, applySlippage } from "../../src/solana";
import { fx, MINT, rpcFor } from "./golden/load";

/**
 * GOLDEN: every number below was produced by the Rally Solana program as DEPLOYED on devnet
 * (cloned into a local validator), by `test/solana/golden/harness.ts`. The harness quoted a
 * swap, then simulated the very transaction `prepareBuy` / `prepareSell` built from that quote,
 * and recorded the program's own `RallySwap` event next to the exact pool, fee-tier, launch and
 * tick-array bytes the program ran against. This replays those bytes OFFLINE through the
 * public quote functions and demands the program's numbers to the unit: no tolerance.
 */
describe("golden: swap quotes equal the program's own events", () => {
  it("covers every scenario family", () => {
    const names = new Set(fx.cases.map((c) => c.name.split(" ")[0]));
    for (const family of ["t0", "decay", "settled", "cross", "moved", "lp", "post"]) expect(names.has(family)).toBe(true);
    expect(Object.keys(fx.snapshots)).toEqual(["fresh", "moved", "outside-lp", "breakout"]);
    expect(fx.cases.filter((c) => c.expected.ok).length).toBeGreaterThan(40);
  });

  for (const c of fx.cases) {
    it(`${c.snapshot}: ${c.name}`, async () => {
      const rpc = rpcFor(c.snapshot);
      const run = c.side === "buy" ? quoteBuySolana : quoteSellSolana;
      const args = { rpc, mint: MINT, amountIn: BigInt(c.amountIn), timestamp: BigInt(c.clock), slippageBps: 100 };
      if (!c.expected.ok) {
        // The program refused (dust that rounds to zero): the quote must refuse too, never invent an output.
        expect(c.expected.programError).toMatch(/TooSmallInputOrOutputAmount/);
        await expect(run(args)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
        return;
      }
      const e = c.expected;
      const q = await run(args);
      if (c.side === "buy") {
        expect(q.amountInUsed).toBe(BigInt(e.quoteAmount));
        expect(q.amountOut).toBe(BigInt(e.tokenAmount));
      } else {
        expect(q.amountOut).toBe(BigInt(e.quoteAmount));
        expect(q.amountInUsed).toBe(BigInt(e.tokenAmount));
      }
      expect(q.fees.routerFee).toBe(BigInt(e.fee));
      expect(q.endSqrtPriceX64).toBe(BigInt(e.sqrtPriceX64));
      expect(q.endTick).toBe(e.tick);
      expect(q.minOut).toBe(applySlippage(q.amountOut, 100));
    });
  }
});

describe("golden: first buy", () => {
  it("the quote is the exact cost: max accepted, one less reverts FirstBuySlippage", async () => {
    const f = fx.firstBuy;
    const q = await quoteFirstBuy({
      firstBuyTokens: BigInt(f.firstBuyTokens),
      curvePreset: 0,
      totalSupply: 1_000_000_000_000_000n,
      curveAllocationBps: 8000,
      tailBps: 10_000,
      gradThreshold: 85_000_000_000n,
      firstBuySupplyCapBps: 200,
    });
    expect(q.quoteCost).toBe(BigInt(f.programQuoteIn));
    expect(q.tokensOut).toBe(BigInt(f.programTokensOut));
    expect(q.maxFirstBuyQuote).toBe(BigInt(f.quoteCost));
    expect(f.exactMaxAccepted).toBe(true);
    expect(f.oneLessLog).toMatch(/FirstBuySlippage/);
  });
});

describe("golden: outside liquidity", () => {
  it("a position opened by someone else breaks the launch-positions-only tick-array list; the quote's arrays do not", async () => {
    // Recorded: the old derivation (arrays from the launch's own positions) was refused by Raydium
    // once an outsider had initialized an array of their own (InvalidFirstTickArrayAccount).
    expect(fx.outsideLiquidityWithoutQuote.withoutQuoteErr).toContain("6024");
    // The quote walks the pool's bitmap, so it finds the outsider's arrays and the program accepted it
    // (the "lp ..." cases above are program-side successes whose request carried the quote's arrays).
    const q = await quoteBuySolana({ rpc: rpcFor("outside-lp"), mint: MINT, amountIn: 30_000_000_000n, timestamp: 1n << 40n });
    expect(q.tickArrayStarts.length).toBeGreaterThan(3);
  });
});
