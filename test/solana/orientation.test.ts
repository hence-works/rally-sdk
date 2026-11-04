import { describe, expect, it } from "vitest";
import { poolOrientation } from "../../src/solana";
import { MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64 } from "../../src/solana/clmm";
import { addr } from "./fixtures";

describe("Solana pool orientation", () => {
  it("preserves the shipped token0 launch convention", () => {
    const o = poolOrientation(addr(1), addr(3));
    expect(o.quoteIsToken0).toBe(false);
    expect(o.mint0).toBe(addr(1));
    expect(o.mint1).toBe(addr(3));
    expect(o.raydiumTick(-7200)).toBe(-7200);
    expect(o.raydiumRange(-7200, 3600)).toEqual([-7200, 3600]);
    expect(o.zeroForOne("buy")).toBe(false);
    expect(o.zeroForOne("sell")).toBe(true);
    expect(o.sqrtPriceLimit("buy")).toBe(MAX_SQRT_PRICE_X64 - 1n);
    expect(o.sqrtPriceLimit("sell")).toBe(MIN_SQRT_PRICE_X64 + 1n);
    expect(o.collectFeeOn).toBe(2);
  });

  it("mirrors Raydium coordinates when the quote is token0", () => {
    const o = poolOrientation(addr(3), addr(1));
    expect(o.quoteIsToken0).toBe(true);
    expect(o.mint0).toBe(addr(1));
    expect(o.mint1).toBe(addr(3));
    expect(o.raydiumTick(-7200)).toBe(7200);
    expect(o.raydiumRange(-7200, 3600)).toEqual([-3600, 7200]);
    expect(o.zeroForOne("buy")).toBe(true);
    expect(o.zeroForOne("sell")).toBe(false);
    expect(o.sqrtPriceLimit("buy")).toBe(MIN_SQRT_PRICE_X64 + 1n);
    expect(o.sqrtPriceLimit("sell")).toBe(MAX_SQRT_PRICE_X64 - 1n);
    expect(o.collectFeeOn).toBe(1);
  });
});
