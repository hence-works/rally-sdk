/**
 * Guards on the two things a caller can get wrong in a way the chain only catches
 * after they have already paid for a grind and a metadata pin.
 */
import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Address } from "viem";
import { parseLaunchReceipt, validateFeeSplit } from "../src/launch";
import { applySlippage, toleranceFor, EXACT_SLIPPAGE_BPS, APPROX_SLIPPAGE_BPS } from "../src/trade";
import { RallyError } from "../src/errors";
import type { FeePolicy } from "../src/types";

const OPEN: FeePolicy = {
  platformBps: 2_500,
  creatorCapBps: 10_000,
  mechanismMask: 7,
  dividendEnabled: true,
  buybackEnabled: true,
  lpSupportEnabled: true,
};

describe("validateFeeSplit", () => {
  it("accepts a split that sums to 10000", () => {
    expect(() =>
      validateFeeSplit(
        { creatorBps: 5_000, dividendBps: 5_000, buybackBps: 0, lpSupportBps: 0 },
        OPEN,
      ),
    ).not.toThrow();
  });

  it("rejects a split that doesn't sum to 10000", () => {
    expect(() =>
      validateFeeSplit({ creatorBps: 100, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 }, OPEN),
    ).toThrow(RallyError);
  });

  it("rejects a creator share over the governance cap", () => {
    const capped: FeePolicy = { ...OPEN, creatorCapBps: 8_000 };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 10_000, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
        capped,
      ),
    ).toThrow(/exceeds the governance cap/);
  });

  it("rejects a mechanism governance has switched off", () => {
    const noBuyback: FeePolicy = { ...OPEN, mechanismMask: 5, buybackEnabled: false };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 5_000, dividendBps: 0, buybackBps: 5_000, lpSupportBps: 0 },
        noBuyback,
      ),
    ).toThrow(/buyback/);
  });

  it("allows a zero share in a disabled mechanism", () => {
    const noBuyback: FeePolicy = { ...OPEN, mechanismMask: 5, buybackEnabled: false };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 10_000, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
        noBuyback,
      ),
    ).not.toThrow();
  });
});

describe("parseLaunchReceipt", () => {
  const HOOK: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";

  it("treats a mined-but-reverted transaction as a failure", () => {
    // waitForTransactionReceipt resolves for a reverted tx too — inclusion is not success.
    const receipt = { status: "reverted", logs: [], transactionHash: keccak256(toHex("x")) };
    expect(() => parseLaunchReceipt(receipt as never, HOOK)).toThrow(/reverted on-chain/);
  });

  it("errors clearly when no Launched event came from the expected hook", () => {
    const receipt = { status: "success", logs: [], transactionHash: keccak256(toHex("x")) };
    expect(() => parseLaunchReceipt(receipt as never, HOOK)).toThrow(/No Launched event/);
  });
});

describe("slippage bounds", () => {
  it("bounds an exact curve estimate tightly and an approximate one loosely", () => {
    expect(toleranceFor(true)).toBe(EXACT_SLIPPAGE_BPS);
    expect(toleranceFor(false)).toBe(APPROX_SLIPPAGE_BPS);
    expect(applySlippage(1_000n, 100n)).toBe(990n);
    expect(applySlippage(1_000n, 500n)).toBe(950n);
  });

  it("returns 0 when there is nothing to bound rather than inventing a floor", () => {
    expect(applySlippage(0n, 100n)).toBe(0n);
    expect(applySlippage(1_000n, 10_000n)).toBe(0n);
  });
});
