/**
 * v4 pool identity for a Rally launch, derived locally.
 *
 * A launch's pool is fully determined by `(quote, token, hook)`: the currencies sort
 * by plain address order (`LaunchCore._sortCurrencies`), the fee is always the dynamic
 * flag, and the tick spacing is fixed. So the `PoolId` every hook read is keyed by can
 * be computed off-chain — no RPC, and knowable *before* the launch transaction lands.
 */
import { concat, encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";

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

/**
 * Storage slot of a pool's `Pool.State` inside the PoolManager singleton.
 *
 * v4 exposes no getters — state is read through `extsload` — so this is `StateLibrary`'s
 * `_getPoolStateSlot`: `keccak256(poolId ‖ bytes32(POOLS_SLOT))`, with `POOLS_SLOT = 6`.
 * The first word at that slot is `slot0`.
 *
 * This matters for PROTOCOL v2 and only for it. A v1 curve pool holds nothing and its
 * price never moves off `P(B)`, so there is nothing here worth reading; a v2 pool IS its
 * curve, so this is where its price lives in both phases.
 */
export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(concat([poolId, toHex(6n, { size: 32 })]));
}

/** Pool state as v4 packs it into `slot0`. */
export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  /** The pool's RESTING fee. A Rally hook overrides it per swap, so this is not what a
   *  trade pays — read `curveFeeBps` for that. */
  lpFee: number;
}

/**
 * Decode the word `extsload(poolStateSlot(pid))` returns.
 *
 * Packed low to high as `sqrtPriceX96(160) | tick(24) | protocolFee(24) | lpFee(24)`.
 * `tick` is a signed 24-bit value, so it is sign-extended rather than masked.
 */
export function decodeSlot0(word: Hex): Slot0 {
  const raw = BigInt(word);
  const tickRaw = Number((raw >> 160n) & 0xffffffn);
  return {
    sqrtPriceX96: raw & ((1n << 160n) - 1n),
    tick: tickRaw >= 0x800000 ? tickRaw - 0x1000000 : tickRaw,
    protocolFee: Number((raw >> 184n) & 0xffffffn),
    lpFee: Number((raw >> 208n) & 0xffffffn),
  };
}

/**
 * Quote per whole token as a WAD, from a pool's `sqrtPriceX96`.
 *
 * `sqrtPriceX96` is `sqrt(currency1/currency0) * 2^96`, so the raw ratio is
 * `(sqrtP/2^96)^2` in base units. `scale` (`10**(36 - quoteDecimals)`, the same value the
 * hook stores per launch) carries it to a WAD price per whole 18dp token, so a 6dp USDC
 * quote and an 18dp wETH quote both come out comparable.
 *
 * Integer throughout: the squaring happens before any division, so nothing is truncated
 * until the final step.
 */
export function priceWadFromSqrtPrice(
  sqrtPriceX96: bigint,
  quoteIsCurrency0: boolean,
  scale: bigint,
): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const num = sqrtPriceX96 * sqrtPriceX96;
  const den = 1n << 192n;
  // token1 per token0 when the quote is currency1; the reciprocal when it is currency0.
  return quoteIsCurrency0 ? (den * scale) / num : (num * scale) / den;
}
