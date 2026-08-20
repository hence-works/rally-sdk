/**
 * Governance-tunable parameters, read from `RallyParamRegistry` rather than hardcoded.
 *
 * Every one of these sits behind a 48h timelock, so a change re-flows to integrators
 * automatically — but only if they read it. The `Key` enum is **append-only**: the
 * ordinal is what goes on the wire, so inserting a key would silently re-label
 * history. Values are cached per client for `paramCacheMs` (default 60s) because they
 * change on the order of days, not blocks.
 */
import { readContract } from "viem/actions";
import { rallyParamRegistryAbi } from "./abis";
import type { CurveParams, FeePolicy, PublicClientLike } from "./types";

/**
 * `RallyParamRegistry.Key` ordinals. Append-only — never reorder.
 *
 * **Renumbered once, breaking.** The two dead `CURVE_CREATOR_SHARE_*` keys that sat at
 * 8 and 9 were deleted from the enum, moving everything below them down by two
 * (`PLATFORM_FEE_BPS` 10 → 8 … `FLUSH_MAX_RESERVE_BPS` 19 → 17). These numbers are only
 * valid against a registry deployed from that revision or later: read an older
 * deployment with them and you get a different parameter back, with no revert — every
 * ordinal in range is a valid key. Check which registry a chain runs before upgrading.
 */
export const REGISTRY_KEYS = {
  LAUNCH_FEE: 0,
  TOTAL_SUPPLY: 1,
  CURVE_ALLOCATION: 2,
  GRAD_THRESHOLD: 3,
  CURVE_FEE_START_BPS: 4,
  CURVE_FEE_END_BPS: 5,
  /** Anti-snipe decay window, seconds (25% → 1% over ~10m at defaults). */
  CURVE_FEE_DECAY: 6,
  POOL_FEE_BPS: 7,
  PLATFORM_FEE_BPS: 8,
  CREATOR_CAP_BPS: 9,
  BUYBACK_MAX_SLIPPAGE_BPS: 10,
  /** bit0 dividend, bit1 buyback, bit2 lp-support. */
  MECHANISM_ENABLE_MASK: 11,
  AUTO_FLUSH_MIN_BPS: 12,
  DEFAULT_CREATOR_BPS: 13,
  DEFAULT_DIVIDEND_BPS: 14,
  DEFAULT_BUYBACK_BPS: 15,
  DEFAULT_LP_SUPPORT_BPS: 16,
  /**
   * Cap on one fee-funded mechanism self-swap, as bps of the graduated pool's depth.
   * Bounds each buyback / lp-support / token-conversion flush against live depth rather
   * than against the accrued bucket, so a long-unflushed bucket drains over several
   * flushes instead of exceeding the slippage bound forever. Reads back 0 on a registry
   * deployed before this key existed, which the hook treats as its safe default (100).
   */
  FLUSH_MAX_RESERVE_BPS: 17,
  /**
   * The referrer's share OF THE PLATFORM'S CUT of a referred trade's fee (§6.2), not of
   * the fee itself. Default 2000 (20% of the platform cut, so 10% of a fee under the
   * default 50% platform rate). Reads back 0 on a registry deployed before this key
   * existed, which simply means referrals are off there.
   */
  REFERRAL_FEE_BPS: 18,
} as const;

export type RegistryKey = (typeof REGISTRY_KEYS)[keyof typeof REGISTRY_KEYS];

/** Read one registry value. */
export function readParam(
  client: PublicClientLike,
  registry: `0x${string}`,
  key: number,
): Promise<bigint> {
  return readContract(client, {
    address: registry,
    abi: rallyParamRegistryAbi,
    functionName: "value",
    args: [key],
  });
}

/**
 * Read several keys at once.
 *
 * Deliberately `Promise.all` over individual `eth_call`s rather than multicall3: not
 * every chain Rally deploys to has multicall3 at the canonical address, and a batching
 * transport collapses these into one request anyway.
 */
export function readParams(
  client: PublicClientLike,
  registry: `0x${string}`,
  keys: number[],
): Promise<bigint[]> {
  return Promise.all(keys.map((k) => readParam(client, registry, k)));
}

export async function readCurveParams(
  client: PublicClientLike,
  registry: `0x${string}`,
): Promise<CurveParams> {
  const [totalSupply, curveAllocation, feeStartBps, feeEndBps, feeDecaySeconds, poolFeeBps] =
    await readParams(client, registry, [
      REGISTRY_KEYS.TOTAL_SUPPLY,
      REGISTRY_KEYS.CURVE_ALLOCATION,
      REGISTRY_KEYS.CURVE_FEE_START_BPS,
      REGISTRY_KEYS.CURVE_FEE_END_BPS,
      REGISTRY_KEYS.CURVE_FEE_DECAY,
      REGISTRY_KEYS.POOL_FEE_BPS,
    ]);
  return {
    totalSupply: totalSupply!,
    curveAllocation: curveAllocation!,
    feeStartBps: feeStartBps!,
    feeEndBps: feeEndBps!,
    feeDecaySeconds: feeDecaySeconds!,
    poolFeeBps: poolFeeBps!,
  };
}

export async function readFeePolicy(
  client: PublicClientLike,
  registry: `0x${string}`,
): Promise<FeePolicy> {
  const [platform, cap, mask] = await readParams(client, registry, [
    REGISTRY_KEYS.PLATFORM_FEE_BPS,
    REGISTRY_KEYS.CREATOR_CAP_BPS,
    REGISTRY_KEYS.MECHANISM_ENABLE_MASK,
  ]);
  const mechanismMask = Number(mask!);
  return {
    platformBps: Number(platform!),
    creatorCapBps: Number(cap!),
    mechanismMask,
    dividendEnabled: (mechanismMask & 1) !== 0,
    buybackEnabled: (mechanismMask & 2) !== 0,
    lpSupportEnabled: (mechanismMask & 4) !== 0,
  };
}

/** A tiny TTL cache so repeated quotes don't re-read timelocked values every call. */
export function createCache<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  let loadedAt = 0;
  return () => {
    const now = Date.now();
    if (!value || now - loadedAt > ttlMs) {
      loadedAt = now;
      value = load().catch((err) => {
        value = null; // don't cache a failure
        throw err;
      });
    }
    return value;
  };
}
