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
import { erc20Abi, rallyHookAbi } from "../src/abis";
import { generationForHook, generationsOf, ZERO_ADDRESS } from "../src/addresses";
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
/** A hook this SDK version has never heard of. */
const HOOK_UNKNOWN: Address = "0x4444444444444444444444444444444444444444";
const ROUTER_UNKNOWN: Address = "0x5555555555555555555555555555555555555555";

const CURRENT_ONLY: RallyAddresses = {
  chainId: 31337,
  deploymentBlock: 100,
  weth: WETH,
  usdc: USDC,
  poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  paramRegistry: "0x0B306BF915C4d645ff596e518fAf3F9669b97016",
  launchLib: "0x68B1D87F95878fE05B998F19b66F4baba5De1aed",
  launchHook: HOOK_V2,
  rallyFactory: FACTORY_V2,
  rallyRouter: ROUTER_V2,
};

const WITH_LEGACY: RallyAddresses = {
  ...CURRENT_ONLY,
  legacyDeployments: [
    { launchHook: HOOK_V1, rallyFactory: FACTORY_V1, rallyRouter: ROUTER_V1, deploymentBlock: 10 },
  ],
};

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
      { launchHook: HOOK_V2, rallyRouter: ROUTER_V2, rallyFactory: FACTORY_V2, deploymentBlock: 100 },
    ]);
    // An explicit empty list means the same thing as no list at all.
    expect(generationsOf({ ...CURRENT_ONLY, legacyDeployments: [] })).toEqual(gens);
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
