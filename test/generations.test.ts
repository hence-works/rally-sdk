/**
 * Hook generations. A v4 hook is part of every PoolKey, so a protocol redeploy cannot
 * migrate pools: a coin launched under an older hook stays bound to that hook, its
 * factory and its router forever. Getting this wrong is not a bad price, it is a swap
 * the router rejects (`NotRallyPool`) or a PoolId that resolves to the zero state, so
 * a live coin looks like it does not exist.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, rallyFactoryAbi, rallyHookAbi, rallyParamRegistryAbi } from "../src/abis";
import { generationForHook, generationsOf, ZERO_ADDRESS } from "../src/addresses";
import { createRallyClient } from "../src/client";
import { REGISTRY_KEYS } from "../src/params";
import { RallyError } from "../src/errors";
import { poolIdFor, poolKeyFor } from "../src/pool";
import {
  prepareClaimReferralFees,
  prepareSwap,
  readReferralFees,
  resolveLaunch,
} from "../src/trade";
import type {
  CurveParams,
  PublicClientLike,
  QuoteConfig,
  RallyAddresses,
} from "../src/types";

const WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const TOKEN: Address = "0x1f60EBa664cb43348a91a50dbcACAE0aDD7a595f";
const TRADER: Address = "0xAebC4577f2DB3A819448d8e1779cfA851B5dbac0";

/** The current generation. */
const HOOK_V2: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";
const ROUTER_V2: Address = "0x9A676e781A523b5d0C0e43731313A708CB607508";
const FACTORY_V2: Address = "0xB237b78903C12B34F6cf099cf5ef701EF158BFE5";
/** The generation before it, still serving the coins launched under it. */
const HOOK_V1: Address = "0x1111111111111111111111111111111111111111";
const ROUTER_V1: Address = "0x2222222222222222222222222222222222222222";
const FACTORY_V1: Address = "0x3333333333333333333333333333333333333333";
/** Each generation ships its own registry and token deployer. */
const REGISTRY_V2: Address = "0x0B306BF915C4d645ff596e518fAf3F9669b97016";
const LAUNCHLIB_V2: Address = "0x68B1D87F95878fE05B998F19b66F4baba5De1aed";
const REGISTRY_V1: Address = "0x6666666666666666666666666666666666666666";
const LAUNCHLIB_V1: Address = "0x7777777777777777777777777777777777777777";
/** The money contracts, which rotate with the generation and are never substituted. */
const VAULT_V2: Address = "0x8888888888888888888888888888888888888888";
const DISTRIBUTOR_V2: Address = "0x9999999999999999999999999999999999999999";
const GACHA_V2: Address = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const VAULT_V1: Address = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const DISTRIBUTOR_V1: Address = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const GACHA_V1: Address = "0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd";
/** A hook this SDK version has never heard of. */
const HOOK_UNKNOWN: Address = "0x4444444444444444444444444444444444444444";
const ROUTER_UNKNOWN: Address = "0x5555555555555555555555555555555555555555";

const CURRENT_ONLY: RallyAddresses = {
  chainId: 31337,
  deploymentBlock: 100,
  weth: WETH,
  usdc: USDC,
  poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  paramRegistry: REGISTRY_V2,
  launchLib: LAUNCHLIB_V2,
  launchHook: HOOK_V2,
  rallyFactory: FACTORY_V2,
  rallyRouter: ROUTER_V2,
};

/** A legacy entry written before the manifest carried a registry: reads the current one. */
const WITH_LEGACY: RallyAddresses = {
  ...CURRENT_ONLY,
  legacyDeployments: [
    { launchHook: HOOK_V1, rallyFactory: FACTORY_V1, rallyRouter: ROUTER_V1, deploymentBlock: 10 },
  ],
};

/** A legacy entry with its own registry and token deployer. */
const WITH_LEGACY_REGISTRY: RallyAddresses = {
  ...CURRENT_ONLY,
  legacyDeployments: [
    {
      launchHook: HOOK_V1,
      rallyFactory: FACTORY_V1,
      rallyRouter: ROUTER_V1,
      paramRegistry: REGISTRY_V1,
      launchLib: LAUNCHLIB_V1,
      deploymentBlock: 10,
    },
  ],
};

/**
 * A legacy entry carrying its own vault, distributor and gacha escrow: the shape a
 * manifest written by the current Deploy.s.sol has.
 */
const WITH_LEGACY_MONEY: RallyAddresses = {
  ...CURRENT_ONLY,
  rallyVault: VAULT_V2,
  dividendDistributor: DISTRIBUTOR_V2,
  gachaVault: GACHA_V2,
  legacyDeployments: [
    {
      launchHook: HOOK_V1,
      rallyFactory: FACTORY_V1,
      rallyRouter: ROUTER_V1,
      paramRegistry: REGISTRY_V1,
      launchLib: LAUNCHLIB_V1,
      rallyVault: VAULT_V1,
      dividendDistributor: DISTRIBUTOR_V1,
      gachaVault: GACHA_V1,
      deploymentBlock: 10,
    },
  ],
};

/** The two registries disagree on total supply, so a read off the wrong one is visible. */
const SUPPLY_V2 = 1_000_000_000n * 10n ** 18n;
const SUPPLY_V1 = 2_000_000_000n * 10n ** 18n;

const PARAMS: CurveParams = {
  totalSupply: 1_000_000_000n * 10n ** 18n,
  curveAllocation: 800_000_000n * 10n ** 18n,
  feeStartBps: 2_500n,
  feeEndBps: 100n,
  feeDecaySeconds: 600n,
  poolFeeBps: 100n,
};

const B = 5n * 10n ** 18n;
const LAUNCHED_AT = 1_700_000_000;

const quoteConfig = async (quote: Address): Promise<QuoteConfig> => ({
  address: quote,
  allowed: true,
  decimals: quote === USDC ? 6 : 18,
  gradThreshold: B,
  launchFee: 0n,
  scale: quote === USDC ? 10n ** 30n : 10n ** 18n,
  isNative: quote === WETH,
});

/**
 * A chain on which `TOKEN` was launched against `quote` under `liveHook`, and nothing
 * else exists. Every other hook answers `phaseOf` with 0 (or reverts, for the unknown
 * one), which is exactly what a hook says about a pool it never registered. Records
 * every `eth_call` target so a test can assert what was probed.
 */
function chainWithLaunch(liveHook: Address, quote: Address, opts: { revertUnknown?: boolean } = {}) {
  const livePid = poolIdFor(poolKeyFor(quote, TOKEN, liveHook));
  const calls: Array<{ to: Address; fn: string }> = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method === "eth_getBlockByNumber") {
          return {
            number: "0x1",
            timestamp: "0x71390b00",
            hash: `0x${"11".repeat(32)}`,
            parentHash: `0x${"00".repeat(32)}`,
            transactions: [],
          };
        }
        if (method !== "eth_call") throw new Error(`unexpected RPC call: ${method}`);
        const { to, data } = params[0] as { to: Address; data: Hex };
        const target = to.toLowerCase();

        // An ERC-20 allowance read (the swap's input leg).
        if (target === WETH.toLowerCase() || target === USDC.toLowerCase() || target === TOKEN.toLowerCase()) {
          calls.push({ to, fn: "allowance" });
          return encodeAbiParameters(parseAbiParameters("uint256"), [0n]);
        }

        // A registry read. Each registry answers with its own supply so a test can tell
        // which one was consulted; every other key is the same on both.
        if (target === REGISTRY_V2.toLowerCase() || target === REGISTRY_V1.toLowerCase()) {
          const { functionName, args } = decodeFunctionData({ abi: rallyParamRegistryAbi, data });
          calls.push({ to, fn: functionName });
          const key = Number((args as readonly [number])[0]);
          const v1 = target === REGISTRY_V1.toLowerCase();
          const table: Record<number, bigint> = {
            [REGISTRY_KEYS.TOTAL_SUPPLY]: v1 ? SUPPLY_V1 : SUPPLY_V2,
            [REGISTRY_KEYS.CURVE_ALLOCATION]: PARAMS.curveAllocation,
            [REGISTRY_KEYS.CURVE_FEE_START_BPS]: PARAMS.feeStartBps,
            [REGISTRY_KEYS.CURVE_FEE_END_BPS]: PARAMS.feeEndBps,
            [REGISTRY_KEYS.CURVE_FEE_DECAY]: PARAMS.feeDecaySeconds,
            [REGISTRY_KEYS.POOL_FEE_BPS]: PARAMS.poolFeeBps,
          };
          return encodeAbiParameters(parseAbiParameters("uint256"), [table[key] ?? 0n]);
        }

        // The current factory's quote allowlist (client-level tests resolve quotes there).
        if (target === FACTORY_V2.toLowerCase()) {
          const { functionName, args } = decodeFunctionData({ abi: rallyFactoryAbi, data });
          calls.push({ to, fn: functionName });
          const q = (args as readonly [Address])[0];
          const usdc = q.toLowerCase() === USDC.toLowerCase();
          return encodeFunctionResult({
            abi: rallyFactoryAbi,
            functionName: "quotes",
            result: [true, usdc ? 6 : 18, B, 0n, usdc ? 10n ** 30n : 10n ** 18n],
          } as never);
        }

        if (opts.revertUnknown && target === HOOK_UNKNOWN.toLowerCase()) {
          throw new Error("execution reverted");
        }

        const decoded = decodeFunctionData({ abi: rallyHookAbi, data });
        calls.push({ to, fn: decoded.functionName });
        const args = decoded.args as readonly unknown[];
        const isLive = target === liveHook.toLowerCase() && args[0] === livePid;
        const result = (value: unknown) =>
          encodeFunctionResult({ abi: rallyHookAbi, functionName: decoded.functionName, result: value } as never);

        switch (decoded.functionName) {
          case "phaseOf":
            return result(isLive ? 1 : 0);
          case "bonded":
            return result(isLive ? 10n ** 18n : 0n);
          case "gradThreshold":
            return result(isLive ? B : 0n);
          case "launchedAt":
            return result(isLive ? BigInt(LAUNCHED_AT) : 0n);
          case "graduatedAt":
            return result(0n);
          case "poolPriceWad":
            return result(0n);
          case "poolReserves":
            return result([0n, PARAMS.curveAllocation]);
          case "feeConfigOf":
            return result({ creatorBps: 10_000, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 });
          case "referralFeesOwed":
            return result(target === HOOK_V1.toLowerCase() ? 7n : 0n);
          default:
            throw new Error(`unexpected hook call: ${decoded.functionName}`);
        }
      },
    }),
  }) as PublicClientLike;
  return { client, calls };
}

const hooksProbed = (calls: Array<{ to: Address; fn: string }>) =>
  [...new Set(calls.filter((c) => c.fn === "phaseOf").map((c) => c.to.toLowerCase()))];

describe("generationsOf", () => {
  it("is just the current generation when the chain has never been redeployed", () => {
    const gens = generationsOf(CURRENT_ONLY);
    expect(gens).toEqual([
      {
        launchHook: HOOK_V2,
        rallyRouter: ROUTER_V2,
        rallyFactory: FACTORY_V2,
        paramRegistry: REGISTRY_V2,
        launchLib: LAUNCHLIB_V2,
        deploymentBlock: 100,
      },
    ]);
    // An explicit empty list means the same thing as no list at all.
    expect(generationsOf({ ...CURRENT_ONLY, legacyDeployments: [] })).toEqual(gens);
  });

  it("keeps each generation's vault, distributor and gacha escrow with that generation", () => {
    const gens = generationsOf(WITH_LEGACY_MONEY);
    const current = gens[0]!;
    const legacy = gens[1]!;
    expect(current.rallyVault).toBe(VAULT_V2);
    expect(current.dividendDistributor).toBe(DISTRIBUTOR_V2);
    expect(current.gachaVault).toBe(GACHA_V2);
    expect(legacy.rallyVault).toBe(VAULT_V1);
    expect(legacy.dividendDistributor).toBe(DISTRIBUTOR_V1);
    expect(legacy.gachaVault).toBe(GACHA_V1);
  });

  it("does NOT fall back to the current money contracts for an entry that omits them", () => {
    // Unlike paramRegistry/launchLib, these hold the generation's own money: the current
    // ones are different contracts, so substituting them would point a dividend claim at a
    // distributor that never funded the epoch. Undefined is the only honest answer.
    const legacy = generationsOf({
      ...WITH_LEGACY_MONEY,
      legacyDeployments: [
        { launchHook: HOOK_V1, rallyFactory: FACTORY_V1, rallyRouter: ROUTER_V1, deploymentBlock: 10 },
      ],
    })[1]!;
    expect(legacy.rallyVault).toBeUndefined();
    expect(legacy.dividendDistributor).toBeUndefined();
    expect(legacy.gachaVault).toBeUndefined();
    // The registry and token deployer DO fall back, and must keep doing so.
    expect(legacy.paramRegistry).toBe(REGISTRY_V2);
    expect(legacy.launchLib).toBe(LAUNCHLIB_V2);
  });

  it("treats a zero money address as absent rather than a real contract", () => {
    const legacy = generationsOf({
      ...WITH_LEGACY_MONEY,
      legacyDeployments: [
        {
          launchHook: HOOK_V1,
          rallyFactory: FACTORY_V1,
          rallyRouter: ROUTER_V1,
          rallyVault: ZERO_ADDRESS,
          dividendDistributor: ZERO_ADDRESS,
          gachaVault: ZERO_ADDRESS,
          deploymentBlock: 10,
        },
      ],
    })[1]!;
    expect(legacy.rallyVault).toBeUndefined();
    expect(legacy.dividendDistributor).toBeUndefined();
    expect(legacy.gachaVault).toBeUndefined();
  });

  it("returns the current generation first, then legacy newest first", () => {
    const older: RallyAddresses = {
      ...WITH_LEGACY,
      legacyDeployments: [
        ...WITH_LEGACY.legacyDeployments!,
        { launchHook: HOOK_UNKNOWN, rallyFactory: FACTORY_V1, rallyRouter: ROUTER_UNKNOWN, deploymentBlock: 1 },
      ],
    };
    expect(generationsOf(older).map((g) => g.launchHook)).toEqual([HOOK_V2, HOOK_V1, HOOK_UNKNOWN]);
    expect(generationsOf(older).map((g) => g.deploymentBlock)).toEqual([100, 10, 1]);
  });

  it("drops a generation with no usable hook or router, and reads a zero factory as absent", () => {
    const messy: RallyAddresses = {
      ...CURRENT_ONLY,
      rallyFactory: ZERO_ADDRESS,
      legacyDeployments: [
        { launchHook: ZERO_ADDRESS, rallyFactory: FACTORY_V1, rallyRouter: ROUTER_V1, deploymentBlock: 10 },
        { launchHook: HOOK_V1, rallyFactory: ZERO_ADDRESS, rallyRouter: ROUTER_V1, deploymentBlock: 5 },
      ],
    };
    const gens = generationsOf(messy);
    expect(gens.map((g) => g.launchHook)).toEqual([HOOK_V2, HOOK_V1]);
    // Same convention as requireFactory: zero means there is none.
    expect(gens.every((g) => g.rallyFactory === undefined)).toBe(true);
  });

  it("fills a legacy entry's missing registry and launchLib from the current ones", () => {
    const [current, legacy] = generationsOf(WITH_LEGACY);
    expect(current!.paramRegistry).toBe(REGISTRY_V2);
    expect(current!.launchLib).toBe(LAUNCHLIB_V2);
    // Written before the manifest carried them: the two were the same contracts then.
    expect(legacy!.paramRegistry).toBe(REGISTRY_V2);
    expect(legacy!.launchLib).toBe(LAUNCHLIB_V2);
  });

  it("keeps a legacy entry's own registry and launchLib when it has them", () => {
    const [, legacy] = generationsOf(WITH_LEGACY_REGISTRY);
    expect(legacy!.paramRegistry).toBe(REGISTRY_V1);
    expect(legacy!.launchLib).toBe(LAUNCHLIB_V1);
    // A zero address is "not carried", not a registry.
    const zeroed: RallyAddresses = {
      ...CURRENT_ONLY,
      legacyDeployments: [
        { ...WITH_LEGACY_REGISTRY.legacyDeployments![0]!, paramRegistry: ZERO_ADDRESS },
      ],
    };
    expect(generationsOf(zeroed)[1]!.paramRegistry).toBe(REGISTRY_V2);
  });

  it("looks a generation up by hook, case-insensitively", () => {
    expect(generationForHook(WITH_LEGACY, HOOK_V1.toLowerCase() as Address)?.rallyRouter).toBe(ROUTER_V1);
    expect(generationForHook(WITH_LEGACY, HOOK_UNKNOWN)).toBeUndefined();
  });
});

describe("resolveLaunch across generations", () => {
  it("finds a coin on the current hook and records that generation", async () => {
    const { client, calls } = chainWithLaunch(HOOK_V2, WETH);
    const launch = await resolveLaunch(client, WITH_LEGACY, TOKEN, [WETH, USDC], quoteConfig);

    expect(launch.hook).toBe(HOOK_V2);
    expect(launch.router).toBe(ROUTER_V2);
    expect(launch.factory).toBe(FACTORY_V2);
    expect(launch.poolKey.hooks).toBe(HOOK_V2);
    // Both generations were asked, in one batch, before anything else was read.
    expect(hooksProbed(calls)).toEqual([HOOK_V2.toLowerCase(), HOOK_V1.toLowerCase()]);
  });

  it("finds a coin that only the LEGACY hook knows, and binds the result to that generation", async () => {
    const { client, calls } = chainWithLaunch(HOOK_V1, USDC);
    const launch = await resolveLaunch(client, WITH_LEGACY, TOKEN, [WETH, USDC], quoteConfig);

    expect(launch.phase).toBe("CURVE");
    expect(launch.quote.address).toBe(USDC);
    expect(launch.hook).toBe(HOOK_V1);
    expect(launch.router).toBe(ROUTER_V1);
    expect(launch.factory).toBe(FACTORY_V1);
    // This entry predates registries on the manifest, so it reads the current one.
    expect(launch.paramRegistry).toBe(REGISTRY_V2);
    expect(launch.launchLib).toBe(LAUNCHLIB_V2);
    // The PoolKey embeds the hook, so it must be the legacy one or the PoolId is wrong.
    expect(launch.poolKey.hooks).toBe(HOOK_V1);
    expect(launch.pid).toBe(poolIdFor(poolKeyFor(USDC, TOKEN, HOOK_V1)));
    // Every state read went to the hook that owns the pool, not the current one.
    const stateReads = calls.filter((c) => c.fn !== "phaseOf" && c.fn !== "allowance");
    expect(stateReads.length).toBeGreaterThan(0);
    expect(stateReads.every((c) => c.to.toLowerCase() === HOOK_V1.toLowerCase())).toBe(true);
    expect(launch.bonded).toBe(10n ** 18n);
    expect(launch.gradThreshold).toBe(B);
  });

  it("would not have found the legacy coin without the legacy generation", async () => {
    const { client } = chainWithLaunch(HOOK_V1, USDC);
    await expect(
      resolveLaunch(client, CURRENT_ONLY, TOKEN, [WETH, USDC], quoteConfig),
    ).rejects.toMatchObject({ code: "LAUNCH_NOT_FOUND" });
  });

  it("names every generation it tried in LAUNCH_NOT_FOUND", async () => {
    const { client } = chainWithLaunch(HOOK_UNKNOWN, WETH);
    const err = await resolveLaunch(client, WITH_LEGACY, TOKEN, [WETH, USDC], quoteConfig).catch((e) => e);
    expect(err).toBeInstanceOf(RallyError);
    expect(err.code).toBe("LAUNCH_NOT_FOUND");
    expect(err.message).toContain("2 hook generations");
    expect(err.message).toContain(HOOK_V2);
    expect(err.message).toContain(HOOK_V1);
    expect(err.details).toMatchObject({ hooks: [HOOK_V2, HOOK_V1] });
  });

  it("probes only the pinned hook when the host already knows the generation", async () => {
    const { client, calls } = chainWithLaunch(HOOK_V1, WETH);
    const launch = await resolveLaunch(client, WITH_LEGACY, TOKEN, [WETH, USDC], quoteConfig, {
      hook: HOOK_V1,
    });

    expect(hooksProbed(calls)).toEqual([HOOK_V1.toLowerCase()]);
    // The quote is still probed: one call per candidate quote, all to the pinned hook.
    expect(calls.filter((c) => c.fn === "phaseOf")).toHaveLength(2);
    // Router and factory fill in from the bundled generation.
    expect(launch.hook).toBe(HOOK_V1);
    expect(launch.router).toBe(ROUTER_V1);
    expect(launch.factory).toBe(FACTORY_V1);
  });

  it("resolves a pinned hook's registry from its generation, or takes the pinned one", async () => {
    const { client } = chainWithLaunch(HOOK_V1, WETH);
    const fromGeneration = await resolveLaunch(client, WITH_LEGACY_REGISTRY, TOKEN, [WETH], quoteConfig, {
      hook: HOOK_V1,
    });
    expect(fromGeneration.paramRegistry).toBe(REGISTRY_V1);
    expect(fromGeneration.launchLib).toBe(LAUNCHLIB_V1);

    // A host with indexer data (Launch.registryAddress) can pin it outright, which is
    // the only way to get it right for a hook the SDK does not know.
    const { client: unknown } = chainWithLaunch(HOOK_UNKNOWN, WETH);
    const pinned = await resolveLaunch(unknown, WITH_LEGACY_REGISTRY, TOKEN, [WETH], quoteConfig, {
      hook: HOOK_UNKNOWN,
      router: ROUTER_UNKNOWN,
      paramRegistry: REGISTRY_V1,
    });
    expect(pinned.paramRegistry).toBe(REGISTRY_V1);
    // Without a pinned registry an unknown hook falls back to the current one.
    const { client: unknown2 } = chainWithLaunch(HOOK_UNKNOWN, WETH);
    const assumed = await resolveLaunch(unknown2, WITH_LEGACY_REGISTRY, TOKEN, [WETH], quoteConfig, {
      hook: HOOK_UNKNOWN,
      router: ROUTER_UNKNOWN,
    });
    expect(assumed.paramRegistry).toBe(REGISTRY_V2);
  });

  it("accepts an unknown hook when its router comes with it", async () => {
    const { client, calls } = chainWithLaunch(HOOK_UNKNOWN, WETH);
    const launch = await resolveLaunch(client, WITH_LEGACY, TOKEN, [WETH, USDC], quoteConfig, {
      hook: HOOK_UNKNOWN,
      router: ROUTER_UNKNOWN,
    });
    expect(hooksProbed(calls)).toEqual([HOOK_UNKNOWN.toLowerCase()]);
    expect(launch.hook).toBe(HOOK_UNKNOWN);
    expect(launch.router).toBe(ROUTER_UNKNOWN);
    expect(launch.factory).toBeUndefined();
  });

  it("refuses an unknown hook without a router rather than guessing the current one", async () => {
    // The router is bound to a single hook (`NotRallyPool`), so the current router would
    // reject every swap built this way. Fail before the probe instead.
    const { client, calls } = chainWithLaunch(HOOK_UNKNOWN, WETH);
    await expect(
      resolveLaunch(client, WITH_LEGACY, TOKEN, [WETH, USDC], quoteConfig, { hook: HOOK_UNKNOWN }),
    ).rejects.toMatchObject({ code: "MISSING_ADDRESS" });
    expect(calls).toHaveLength(0);
  });

  it("survives a pinned or legacy hook that reverts the probe", async () => {
    // A hook that reverts `phaseOf` (a proxy gone dark, a wrong address) counts as
    // "not here", the same as before generations existed.
    const { client } = chainWithLaunch(HOOK_V2, WETH, { revertUnknown: true });
    const withDark: RallyAddresses = {
      ...WITH_LEGACY,
      legacyDeployments: [
        { launchHook: HOOK_UNKNOWN, rallyFactory: FACTORY_V1, rallyRouter: ROUTER_UNKNOWN, deploymentBlock: 1 },
      ],
    };
    const launch = await resolveLaunch(client, withDark, TOKEN, [WETH], quoteConfig);
    expect(launch.hook).toBe(HOOK_V2);
  });
});

describe("trading a legacy-generation coin", () => {
  it("prepareSwap targets the coin's own router and hook, not the current ones", async () => {
    const { client } = chainWithLaunch(HOOK_V1, WETH);
    const launch = await resolveLaunch(client, WITH_LEGACY, TOKEN, [WETH, USDC], quoteConfig);
    const prepared = await prepareSwap(client, WITH_LEGACY, launch, PARAMS, {
      side: "buy",
      amountIn: 10n ** 17n,
      trader: TRADER,
      atTime: LAUNCHED_AT + 3_600,
    });

    // The swap goes to the legacy router...
    expect(prepared.request.to).toBe(ROUTER_V1);
    expect(prepared.request.to).not.toBe(WITH_LEGACY.rallyRouter);
    // ...the approval names the legacy router as spender...
    expect(prepared.approval).toBeDefined();
    const approval = decodeFunctionData({ abi: erc20Abi, data: prepared.approval!.data });
    expect((approval.args as readonly [Address, bigint])[0]).toBe(ROUTER_V1);
    // ...and the PoolKey the router will swap on embeds the legacy hook.
    expect(prepared.poolKey.hooks).toBe(HOOK_V1);
    expect(prepared.request.chainId).toBe(WITH_LEGACY.chainId);
  });
});

describe("governance params per generation", () => {
  function rally(client: PublicClientLike) {
    return createRallyClient({ chainId: 31337, publicClient: client, addresses: WITH_LEGACY_REGISTRY });
  }
  const registryReads = (calls: Array<{ to: Address; fn: string }>) =>
    [...new Set(calls.filter((c) => c.fn === "value").map((c) => c.to.toLowerCase()))];

  it("prices a legacy coin off the LEGACY registry, not the current one", async () => {
    const { client, calls } = chainWithLaunch(HOOK_V1, WETH);
    const q = await rally(client).quote(TOKEN, { side: "buy", amountIn: 10n ** 17n, atTime: LAUNCHED_AT + 3_600 });

    expect(registryReads(calls)).toEqual([REGISTRY_V1.toLowerCase()]);
    expect(q.amountOut > 0n).toBe(true);
  });

  it("prices a current coin off the current registry", async () => {
    const { client, calls } = chainWithLaunch(HOOK_V2, WETH);
    await rally(client).quote(TOKEN, { side: "buy", amountIn: 10n ** 17n, atTime: LAUNCHED_AT + 3_600 });
    expect(registryReads(calls)).toEqual([REGISTRY_V2.toLowerCase()]);
  });

  it("caches per registry: the two generations do not share values", async () => {
    const { client, calls } = chainWithLaunch(HOOK_V2, WETH);
    const r = rally(client);
    const current = await r.getCurveParams();
    const legacy = await r.getCurveParams(REGISTRY_V1);
    expect(current.totalSupply).toBe(SUPPLY_V2);
    expect(legacy.totalSupply).toBe(SUPPLY_V1);
    // Second reads are cache hits: no new registry calls.
    const before = calls.filter((c) => c.fn === "value").length;
    await r.getCurveParams();
    await r.getCurveParams(REGISTRY_V1);
    expect(calls.filter((c) => c.fn === "value").length).toBe(before);
    // Fee policy has its own cache, keyed the same way.
    await r.getFeePolicy();
    const afterPolicy = calls.filter((c) => c.fn === "value").length;
    expect(afterPolicy).toBeGreaterThan(before);
    await r.getFeePolicy();
    expect(calls.filter((c) => c.fn === "value").length).toBe(afterPolicy);
    expect(registryReads(calls).sort()).toEqual([REGISTRY_V2, REGISTRY_V1].map((a) => a.toLowerCase()).sort());
  });

  it("prepareSwap on a legacy coin reads params from the legacy registry and routes to the legacy router", async () => {
    const { client, calls } = chainWithLaunch(HOOK_V1, WETH);
    const prepared = await rally(client).prepareSwap(TOKEN, {
      side: "buy",
      amountIn: 10n ** 17n,
      trader: TRADER,
      atTime: LAUNCHED_AT + 3_600,
    });
    expect(registryReads(calls)).toEqual([REGISTRY_V1.toLowerCase()]);
    expect(prepared.request.to).toBe(ROUTER_V1);
    expect(prepared.poolKey.hooks).toBe(HOOK_V1);
  });
});

describe("referral fees per hook", () => {
  it("default to the current hook, and read a legacy hook's balance when asked", async () => {
    const { client } = chainWithLaunch(HOOK_V2, WETH);
    expect(await readReferralFees(client, WITH_LEGACY, TRADER, WETH)).toBe(0n);
    expect(await readReferralFees(client, WITH_LEGACY, TRADER, WETH, HOOK_V1)).toBe(7n);
  });

  it("prepareClaimReferralFees can target a legacy hook", () => {
    expect(prepareClaimReferralFees(WITH_LEGACY, WETH).to).toBe(HOOK_V2);
    expect(prepareClaimReferralFees(WITH_LEGACY, WETH, HOOK_V1).to).toBe(HOOK_V1);
  });
});
