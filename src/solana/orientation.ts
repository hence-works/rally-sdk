import type { Address } from "@solana/kit";
import { RallyError } from "../errors";
import { MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64 } from "./clmm";
import { sortsBelow } from "./address";

export type SwapSide = "buy" | "sell";

/**
 * Pure adapter between Rally's economic token/quote coordinates and Raydium's
 * canonical token0/token1 coordinates. Rally account ticks always remain
 * quote-per-token; only values crossing the Raydium boundary are mirrored.
 */
export interface PoolOrientation {
  readonly quoteIsToken0: boolean;
  readonly mint0: Address;
  readonly mint1: Address;
  readonly collectFeeOn: 1 | 2;
  /** Map a stored economic boundary tick into Raydium's boundary coordinate. */
  raydiumTick(economicTick: number): number;
  raydiumRange(economicLower: number, economicUpper: number): readonly [number, number];
  zeroForOne(side: SwapSide): boolean;
  sqrtPriceLimit(side: SwapSide): bigint;
  tokenQuoteAmounts(amount0: bigint, amount1: bigint): readonly [token: bigint, quote: bigint];
  raydiumAmounts(token: bigint, quote: bigint): readonly [amount0: bigint, amount1: bigint];
}

export function poolOrientation(mint: Address, quoteMint: Address): PoolOrientation {
  if (mint === quoteMint) throw new RallyError("INVALID_ADDRESS", "Launch mint and quote mint must differ");
  const quoteIsToken0 = sortsBelow(quoteMint, mint);
  const mint0 = quoteIsToken0 ? quoteMint : mint;
  const mint1 = quoteIsToken0 ? mint : quoteMint;
  const mirror = (tick: number) => quoteIsToken0 ? -tick : tick;
  const zeroForOne = (side: SwapSide) => (side === "sell") !== quoteIsToken0;
  return {
    quoteIsToken0,
    mint0,
    mint1,
    collectFeeOn: quoteIsToken0 ? 1 : 2,
    raydiumTick: mirror,
    raydiumRange: (lower, upper) => quoteIsToken0 ? [-upper, -lower] : [lower, upper],
    zeroForOne,
    sqrtPriceLimit: (side) => zeroForOne(side) ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n,
    tokenQuoteAmounts: (amount0, amount1) => quoteIsToken0 ? [amount1, amount0] : [amount0, amount1],
    raydiumAmounts: (token, quote) => quoteIsToken0 ? [quote, token] : [token, quote],
  };
}
