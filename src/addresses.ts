/**
 * Resolving the contract set for a chain.
 *
 * Addresses are baked into the published bundle (see `deployments.ts`, regenerated
 * from the monorepo manifests) because an npm consumer has no access to the private
 * `@rally/deployments` workspace. Anything missing or newer than this SDK version is
 * covered by the `addresses` override on `createRallyClient`.
 */
import { isAddress, type Address } from "viem";
import { DEPLOYMENTS } from "./deployments";
import { RallyError } from "./errors";
import type { HookGeneration, RallyAddresses } from "./types";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Chains this SDK version ships addresses for. */
export function listSupportedChains(): number[] {
  return Object.keys(DEPLOYMENTS).map(Number);
}

/** The bundled record for a chain, or undefined. Overrides are not applied. */
export function getBundledAddresses(chainId: number): RallyAddresses | undefined {
  return DEPLOYMENTS[chainId];
}

/**
 * The effective address set: bundled values with `overrides` layered on top. A chain
 * absent from both throws — silently defaulting to zero addresses would send a launch
 * fee into the void.
 */
export function resolveAddresses(
  chainId: number,
  overrides?: Partial<RallyAddresses>,
): RallyAddresses {
  const base = DEPLOYMENTS[chainId];
  if (!base && !overrides) {
    throw new RallyError(
      "UNSUPPORTED_CHAIN",
      `No bundled Rally deployment for chain ${chainId}. Known chains: ${listSupportedChains().join(
        ", ",
      )}. Pass \`addresses\` to createRallyClient to use an unbundled deployment.`,
      { details: { chainId } },
    );
  }
  const merged = { ...(base ?? {}), ...(overrides ?? {}), chainId } as RallyAddresses;

  // Every read/write path needs these four; the rest are optional per-deployment.
  for (const key of ["launchHook", "rallyRouter", "paramRegistry", "weth"] as const) {
    const value = merged[key];
    if (!value || !isAddress(value) || value === ZERO_ADDRESS) {
      throw new RallyError(
        "MISSING_ADDRESS",
        `Chain ${chainId} has no usable \`${key}\` address (got ${String(value)}). ` +
          `That deployment is incomplete — pass \`addresses\` to override it.`,
        { details: { chainId, key, value } },
      );
    }
  }
  return merged;
}

/**
 * The factory, or a clear error. Launching runs entirely through it, and a manifest
 * predating the creation-path split has no address for it — better to fail loudly than
 * to send the launch fee to the zero address.
 */
export function requireFactory(addresses: RallyAddresses): Address {
  const factory = addresses.rallyFactory;
  if (!factory || factory === ZERO_ADDRESS) {
    throw new RallyError(
      "MISSING_ADDRESS",
      `Launching isn't available on chain ${addresses.chainId}: no RallyFactory deployed.`,
      { details: { chainId: addresses.chainId } },
    );
  }
  return factory;
}

/** A usable, non-zero address. */
function usable(value: Address | undefined): value is Address {
  return Boolean(value) && isAddress(value as string) && value !== ZERO_ADDRESS;
}

/**
 * Every hook generation live on a chain: the current one first, then each legacy one
 * newest first (the order `legacyDeployments` is written in).
 *
 * A v4 hook is part of every PoolKey, so a redeploy cannot migrate pools: coins launched
 * under an earlier generation keep trading against that generation's hook and router.
 * `resolveLaunch` probes these in order to find which one a coin belongs to. Entries
 * missing a hook or router are dropped rather than probed, and a zero factory reads as
 * absent, matching `requireFactory`.
 *
 * Every generation ships its own `RallyParamRegistry` and `LaunchLib`. A legacy entry
 * written before the manifest carried them reads the current ones: the two were the same
 * contracts when such a manifest was written, so this is history, not a guess.
 *
 * `rallyVault`, `dividendDistributor` and `gachaVault` get no such fallback and pass
 * through as recorded. They rotate with the generation and hold that generation's money,
 * so the current ones are the WRONG contracts for a legacy coin, not stale copies of the
 * right ones; undefined is the honest answer and a caller must skip rather than assume.
 */
export function generationsOf(addresses: RallyAddresses): HookGeneration[] {
  const raw: Array<{
    launchHook?: Address;
    rallyRouter?: Address;
    rallyFactory?: Address;
    paramRegistry?: Address;
    launchLib?: Address;
    rallyVault?: Address;
    dividendDistributor?: Address;
    gachaVault?: Address;
    deploymentBlock?: number;
  }> = [
    {
      launchHook: addresses.launchHook,
      rallyRouter: addresses.rallyRouter,
      rallyFactory: addresses.rallyFactory,
      paramRegistry: addresses.paramRegistry,
      launchLib: addresses.launchLib,
      rallyVault: addresses.rallyVault,
      dividendDistributor: addresses.dividendDistributor,
      gachaVault: addresses.gachaVault,
      deploymentBlock: addresses.deploymentBlock,
    },
    ...(addresses.legacyDeployments ?? []),
  ];
  const out: HookGeneration[] = [];
  for (const g of raw) {
    if (!usable(g.launchHook) || !usable(g.rallyRouter)) continue;
    out.push({
      launchHook: g.launchHook,
      rallyRouter: g.rallyRouter,
      rallyFactory: usable(g.rallyFactory) ? g.rallyFactory : undefined,
      paramRegistry: usable(g.paramRegistry) ? g.paramRegistry : addresses.paramRegistry,
      launchLib: usable(g.launchLib) ? g.launchLib : addresses.launchLib,
      rallyVault: usable(g.rallyVault) ? g.rallyVault : undefined,
      dividendDistributor: usable(g.dividendDistributor) ? g.dividendDistributor : undefined,
      gachaVault: usable(g.gachaVault) ? g.gachaVault : undefined,
      deploymentBlock: g.deploymentBlock ?? 0,
    });
  }
  return out;
}

/** The generation whose hook is `hook` (case-insensitive), or undefined if unknown. */
export function generationForHook(
  addresses: RallyAddresses,
  hook: Address,
): HookGeneration | undefined {
  const wanted = hook.toLowerCase();
  return generationsOf(addresses).find((g) => g.launchHook.toLowerCase() === wanted);
}

/**
 * Known wETH/<quote> Uniswap **v3** pools per chain, used by `swapExactEthIn` to buy a
 * launch quoted in something the trader doesn't hold. Keyed by lowercased quote
 * address. Caller-supplied by design — the router stores no venue config — so these
 * are a convenience default, always re-validated on-chain (`token0`/`token1` must be
 * exactly the wETH/quote pair) before the SDK builds a transaction against one.
 */
export const ETH_ROUTES: Record<number, Record<string, Address>> = {
  // Sepolia: the canonical USDC/wETH 0.05% pool — also the indexer's price reference.
  11155111: {
    "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238":
      "0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1",
  },
  // Robinhood: the wETH/stable reference pool (apps/indexer/src/referencePools.json).
  4663: {
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168":
      "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca",
  },
};

/** The default v3 route for an ETH-funded buy of a `quote`-denominated launch. */
export function defaultEthRoute(chainId: number, quote: Address): Address | undefined {
  return ETH_ROUTES[chainId]?.[quote.toLowerCase()];
}
