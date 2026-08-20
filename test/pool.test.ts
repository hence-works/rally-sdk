/**
 * Pool identity is derived locally, so it has to match what the hook computes. If
 * `poolIdFor` were wrong, every read would silently return the zero state — a launch
 * that exists would look like it doesn't.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, type Address } from "viem";
import { V4, poolIdFor, poolIdOf, poolKeyFor, sortCurrencies } from "../src/pool";

const HOOK: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";
const WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
// Sorts below wETH; the vanity prefix makes launch tokens cluster low.
const TOKEN: Address = "0xba5e0000000000000000000000000000000000ff";

describe("sortCurrencies", () => {
  it("orders by plain address value, as LaunchCore._sortCurrencies does", () => {
    const sorted = sortCurrencies(WETH, TOKEN);
    expect(sorted.currency0).toBe(TOKEN);
    expect(sorted.currency1).toBe(WETH);
    expect(sorted.quoteIsCurrency0).toBe(false);
  });

  it("puts the quote first when it sorts lower", () => {
    const usdc: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    const sorted = sortCurrencies(usdc, TOKEN);
    expect(sorted.quoteIsCurrency0).toBe(true);
    expect(sorted.currency0).toBe(usdc);
  });

  it("is case-insensitive — a checksummed address must not sort differently", () => {
    const lower = sortCurrencies(WETH.toLowerCase() as Address, TOKEN);
    const checksummed = sortCurrencies(WETH, TOKEN);
    expect(lower.quoteIsCurrency0).toBe(checksummed.quoteIsCurrency0);
  });
});

describe("poolKeyFor", () => {
  it("uses the dynamic fee flag and Rally's tick spacing", () => {
    const key = poolKeyFor(WETH, TOKEN, HOOK);
    expect(key.fee).toBe(V4.DYNAMIC_FEE_FLAG);
    expect(key.tickSpacing).toBe(60);
    expect(key.hooks).toBe(HOOK);
  });
});

describe("poolIdFor", () => {
  it("is keccak256(abi.encode(key)) — v4's PoolIdLibrary.toId", () => {
    const key = poolKeyFor(WETH, TOKEN, HOOK);
    const expected = keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint24" },
          { type: "int24" },
          { type: "address" },
        ],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      ),
    );
    expect(poolIdFor(key)).toBe(expected);
    expect(poolIdFor(key)).toHaveLength(66);
  });

  it("is order-independent in its inputs — the same launch, one id", () => {
    expect(poolIdOf(WETH, TOKEN, HOOK)).toBe(poolIdOf(TOKEN, WETH, HOOK));
  });

  it("separates the same token launched against different quotes", () => {
    const usdc: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    expect(poolIdOf(WETH, TOKEN, HOOK)).not.toBe(poolIdOf(usdc, TOKEN, HOOK));
  });
});
