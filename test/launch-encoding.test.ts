/**
 * What `prepareLaunch` actually puts on the wire for a v2 launch.
 *
 * v2's factory used to expose four `launch` overloads and `launchCustom`; they are one
 * calldata struct now, because the generated decoder for a 10-parameter external function
 * is more than the legacy code generator can schedule and the protocol builds without
 * via-IR. The overload the SDK picked used to be the whole encoding decision, so nothing
 * here asserted it. With one entrypoint the decision moved INTO the argument, where a
 * wrong default is silent: an unnamed `curvePreset` is a real curve shape, not an absent
 * one, and a creator who asked for nothing but a fee split would get a coin whose
 * allocation is front- or back-loaded without ever having said so.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Address,
  type Hex,
} from "viem";
import { rallyFactoryU4Abi } from "../src/abis";
import { prepareLaunch, type LaunchParams } from "../src/launch";
import { packSalt } from "../src/salt";
import type { FeePolicy, RallyAddresses } from "../src/types";

const WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const HOOK_V2: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";
const ROUTER_V2: Address = "0x9A676e781A523b5d0C0e43731313A708CB607508";
const FACTORY_V2: Address = "0xB237b78903C12B34F6cf099cf5ef701EF158BFE5";
const REGISTRY_V2: Address = "0x0B306BF915C4d645ff596e518fAf3F9669b97016";
const LAUNCHLIB_V2: Address = "0x68B1D87F95878fE05B998F19b66F4baba5De1aed";
const TOKEN: Address = "0x1f60EBa664cb43348a91a50dbcACAE0aDD7a595f";
const CREATOR: Address = "0xAebC4577f2DB3A819448d8e1779cfA851B5dbac0";

/** The factory's own defaults, which a caller who names one row inherits for the other. */
const DEFAULT_CURVE = [4000, 0, 4000, 2000] as const;
const DEFAULT_BREAKOUT = [7000, 0, 2000, 1000] as const;

const ADDRESSES: RallyAddresses = {
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
  v2Deployments: [
    {
      launchHook: HOOK_V2,
      rallyFactory: FACTORY_V2,
      rallyRouter: ROUTER_V2,
      paramRegistry: REGISTRY_V2,
      launchLib: LAUNCHLIB_V2,
      deploymentBlock: 100,
    },
  ],
};

/** A factory that answers only the reads `prepareLaunch` makes on the way to calldata. */
function factoryClient() {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method !== "eth_call") throw new Error(`unexpected RPC call: ${method}`);
        const { data } = params[0] as { to: Address; data: Hex };
        const { functionName } = decodeFunctionData({ abi: rallyFactoryU4Abi, data });
        const result = (() => {
          switch (functionName) {
            // allowed, decimals, gradThreshold, launchFee, scale
            case "quotes":
              return [true, 18, 10n ** 21n, 10n ** 16n, 10n ** 18n];
            case "tokenInitCodeHash":
              return `0x${"ab".repeat(32)}` as Hex;
            case "launchLib":
              return LAUNCHLIB_V2;
            case "predictToken":
              return TOKEN;
            case "defaultFeeConfig":
              return DEFAULT_CURVE;
            case "defaultBreakoutFeeConfig":
              return DEFAULT_BREAKOUT;
            default:
              throw new Error(`unexpected factory read: ${functionName}`);
          }
        })();
        return encodeFunctionResult({
          abi: rallyFactoryU4Abi,
          functionName,
          result: result as never,
        });
      },
    }),
  });
}

const SALT = packSalt(CREATOR, 7n);

/** Wide enough that no split under test is rejected before it can be encoded. */
const FEE_POLICY: FeePolicy = {
  platformBps: 1000,
  creatorCapBps: 10000,
  breakoutCreatorCapBps: 10000,
  mechanismMask: 0b111,
  dividendEnabled: true,
  buybackEnabled: true,
  lpSupportEnabled: true,
};

async function launchCalldata(extra: Partial<LaunchParams>) {
  const prepared = await prepareLaunch(
    {
      client: factoryClient(),
      addresses: ADDRESSES,
      factory: FACTORY_V2,
      feePolicy: async () => FEE_POLICY,
      resolveQuote: () => WETH,
    },
    {
      name: "Noodle",
      symbol: "NDL",
      metadataURI: "https://rally.fun/31337/noodle.json",
      quote: WETH,
      creator: CREATOR,
      salt: SALT,
      protocolVersion: 2,
      ...extra,
    },
  );
  return decodeFunctionData({ abi: rallyFactoryU4Abi, data: prepared.request.data });
}

describe("v2 launch calldata", () => {
  it("uses the 6-arg form when the caller asked for nothing beyond the defaults", async () => {
    const { functionName, args } = await launchCalldata({});
    expect(functionName).toBe("launch");
    // Six positional arguments, not one struct: the factory fills both fee rows and the
    // curve itself, so nothing here has to be read to send it.
    expect(args).toHaveLength(6);
  });

  it("names every field once anything is customised, since a struct has no tail to omit", async () => {
    const fees = { creatorBps: 5000, dividendBps: 0, buybackBps: 3000, lpSupportBps: 2000 };
    const { args } = await launchCalldata({ fees });
    expect(args).toHaveLength(1);
    const a = (args as readonly [Record<string, unknown>])[0];

    expect(a.feeConfig).toEqual(fees);
    // The row the caller did NOT name falls back to the factory's value for THAT row.
    // Copying the named row across would silently rewrite the other, and they are
    // validated against different creator ceilings.
    expect(a.breakoutFeeConfig).toEqual({
      creatorBps: DEFAULT_BREAKOUT[0],
      dividendBps: DEFAULT_BREAKOUT[1],
      buybackBps: DEFAULT_BREAKOUT[2],
      lpSupportBps: DEFAULT_BREAKOUT[3],
    });
    // PRESET_FLAT. This is the regression the struct made possible: both removed overloads
    // that took no preset passed exactly this, so naming only a fee split must not change
    // the curve the creator gets.
    expect(a.curvePreset).toBe(0);
    expect(a.segments).toEqual([]);
  });

  it("carries a chosen preset with an empty segment list", async () => {
    const { args } = await launchCalldata({ curvePreset: 2 });
    const a = (args as readonly [Record<string, unknown>])[0];
    expect(a.curvePreset).toBe(2);
    expect(a.segments).toEqual([]);
    // Neither fee row was named, so both come from the factory. Picking a SHAPE must not
    // move a creator's fee routing.
    expect(a.feeConfig).toEqual({
      creatorBps: DEFAULT_CURVE[0],
      dividendBps: DEFAULT_CURVE[1],
      buybackBps: DEFAULT_CURVE[2],
      lpSupportBps: DEFAULT_CURVE[3],
    });
  });

  it("carries a custom shape as segments, which the factory reads instead of the preset", async () => {
    const segments = [
      { startBps: 0, endBps: 5000, numPositions: 10, sharesBps: 6000, anchorAtFar: false },
      { startBps: 5000, endBps: 10000, numPositions: 10, sharesBps: 4000, anchorAtFar: true },
    ];
    const { args } = await launchCalldata({ curveSegments: segments });
    const a = (args as readonly [Record<string, unknown>])[0];
    expect(a.segments).toEqual(segments);
    // Non-empty `segments` makes `curvePreset` dead on the factory's side, so the value
    // sent is irrelevant rather than wrong. Pinned so a later change has to be deliberate.
    expect(a.curvePreset).toBe(0);
  });
});
