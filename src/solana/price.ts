import { RallyError } from "../errors";
import { LAUNCH_TOKEN_DECIMALS } from "./constants";

/**
 * `10 ** (18 + tokenDecimals - quoteDecimals)`: the factor that turns a Raydium
 * `sqrtPriceX64`-derived ratio of base units into a WAD of whole-quote per whole-token.
 * EVM is the same formula with 18dp tokens (`10 ** (36 - quoteDecimals)`).
 */
export function priceScale(quoteDecimals: number, tokenDecimals: number = LAUNCH_TOKEN_DECIMALS): bigint {
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) {
    throw new RallyError("INVALID_AMOUNT", `Bad quote decimals: ${quoteDecimals}`);
  }
  const exp = 18 + tokenDecimals - quoteDecimals;
  if (exp < 0) throw new RallyError("INVALID_AMOUNT", "Quote decimals exceed 18 + token decimals");
  return 10n ** BigInt(exp);
}

const Q128 = 1n << 128n;

/**
 * Spot price of the launch token in quote, as a WAD (1e18 = one quote per token), from a
 * Raydium pool's `sqrtPriceX64`. When quote is token1, price is
 * `sqrtPriceX64^2 * scale / 2^128`; when quote is token0 the pool ratio is reciprocal,
 * so price is `2^128 * scale / sqrtPriceX64^2`. Integer math, rounded down.
 *
 * Unlike the EVM virtual curve, a Solana curve is real Raydium liquidity from the first
 * slot, so the pool's own price IS the spot price in every phase.
 */
export function priceWadFromSqrtPriceX64(
  sqrtPriceX64: bigint,
  quoteDecimals: number,
  quoteIsToken0: boolean = false,
): bigint {
  if (sqrtPriceX64 < 0n) throw new RallyError("INVALID_AMOUNT", "sqrtPriceX64 must be non-negative");
  if (quoteIsToken0) {
    if (sqrtPriceX64 === 0n) throw new RallyError("INVALID_AMOUNT", "sqrtPriceX64 must be positive for a reciprocal price");
    return (Q128 * priceScale(quoteDecimals)) / (sqrtPriceX64 * sqrtPriceX64);
  }
  return (sqrtPriceX64 * sqrtPriceX64 * priceScale(quoteDecimals)) / Q128;
}
