import { describe, expect, it } from "vitest";
import { RallyError, normalizeAddress, normalizeSolanaAddress, priceScale, priceWadFromSqrtPriceX64 } from "../../src/solana";

const Q64 = 1n << 64n;

describe("price scale", () => {
  it("is 10^(18 + 6 - quoteDecimals)", () => {
    expect(priceScale(9)).toBe(10n ** 15n); // wSOL
    expect(priceScale(6)).toBe(10n ** 18n); // USDC
  });
  it("rejects nonsense decimals", () => {
    expect(() => priceScale(-1)).toThrow(RallyError);
    expect(() => priceScale(1.5)).toThrow(RallyError);
  });
});

describe("priceWadFromSqrtPriceX64", () => {
  it("sqrtPrice 1.0 against a 6dp quote is 1.0 quote per token: ratio 1 in base units, 6dp each", () => {
    expect(priceWadFromSqrtPriceX64(Q64, 6)).toBe(10n ** 18n);
  });
  it("is quote-decimal aware: the same pool ratio reads 1000x smaller against a 9dp quote", () => {
    // sqrtPriceX64 for r = 4 is exactly 2 * 2^64.
    expect(priceWadFromSqrtPriceX64(2n * Q64, 9)).toBe(4n * 10n ** 15n);
    expect(priceWadFromSqrtPriceX64(2n * Q64, 6)).toBe(4n * 10n ** 18n);
  });
  it("a pool at ratio 1 against wSOL is 0.001 SOL per token (1e6 token units = 1e6 lamports)", () => {
    expect(priceWadFromSqrtPriceX64(Q64, 9)).toBe(10n ** 15n);
  });
  it("rounds down and is exact integer math (no float drift at large values)", () => {
    const sqrt = Q64 * 123_456_789n + 987_654_321n;
    const expected = (sqrt * sqrt * 10n ** 15n) / (1n << 128n);
    expect(priceWadFromSqrtPriceX64(sqrt, 9)).toBe(expected);
  });
  it("zero price is zero", () => {
    expect(priceWadFromSqrtPriceX64(0n, 9)).toBe(0n);
  });
});

describe("address normalization", () => {
  const KEY = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  it("returns a valid Solana key unchanged (base58 is case-sensitive)", () => {
    expect(normalizeSolanaAddress(KEY)).toBe(KEY);
    expect(normalizeAddress("svm", KEY)).toBe(KEY);
  });
  it("rejects bad lengths, bad alphabet and EVM keys", () => {
    for (const bad of ["", "abc", KEY + "1", KEY.slice(0, 30), "0x" + "11".repeat(20), KEY.replace("z", "0")]) {
      expect(() => normalizeSolanaAddress(bad)).toThrow(RallyError);
    }
  });
  it("lowercases EVM and validates its shape", () => {
    const evm = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    expect(normalizeAddress("evm", evm)).toBe(evm.toLowerCase());
    expect(() => normalizeAddress("evm", KEY)).toThrow(RallyError);
  });
});
