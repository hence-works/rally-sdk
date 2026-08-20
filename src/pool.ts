/**
 * v4 pool identity for a Rally launch, derived locally.
 *
 * A launch's pool is fully determined by `(quote, token, hook)`: the currencies sort
 * by plain address order (`LaunchCore._sortCurrencies`), the fee is always the dynamic
 * flag, and the tick spacing is fixed. So the `PoolId` every hook read is keyed by can
 * be computed off-chain — no RPC, and knowable *before* the launch transaction lands.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** v4 constants for Rally pools (see RallyHook.sol / LaunchCore.sol). */
export const V4 = {
  /** LPFeeLibrary.DYNAMIC_FEE_FLAG — Rally pools price the fee in the hook. */
  DYNAMIC_FEE_FLAG: 0x800000,
  TICK_SPACING: 60,
  /** TickMath bounds; ±1 makes a swap's price limit non-binding. */
  MIN_SQRT_RATIO: 4295128739n,
  MAX_SQRT_RATIO: 1461446703485210103287273052203988822378723970342n,
} as const;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Currency ordering is plain address order; `quoteIsCurrency0` decides every leg. */
export function sortCurrencies(
  quote: Address,
  token: Address,
): { currency0: Address; currency1: Address; quoteIsCurrency0: boolean } {
  const quoteIsCurrency0 = quote.toLowerCase() < token.toLowerCase();
  return quoteIsCurrency0
    ? { currency0: quote, currency1: token, quoteIsCurrency0 }
    : { currency0: token, currency1: quote, quoteIsCurrency0 };
}

/** The PoolKey for a launch, matching `LaunchCore._keyOf`. */
export function poolKeyFor(quote: Address, token: Address, hook: Address): PoolKey {
  const { currency0, currency1 } = sortCurrencies(quote, token);
  return {
    currency0,
    currency1,
    fee: V4.DYNAMIC_FEE_FLAG,
    tickSpacing: V4.TICK_SPACING,
    hooks: hook,
  };
}

/** `PoolId = keccak256(abi.encode(key))` — v4's `PoolIdLibrary.toId`. */
export function poolIdFor(key: PoolKey): Hex {
  return keccak256(
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
}

/** Convenience: the PoolId for a launch straight from its parts. */
export function poolIdOf(quote: Address, token: Address, hook: Address): Hex {
  return poolIdFor(poolKeyFor(quote, token, hook));
}
