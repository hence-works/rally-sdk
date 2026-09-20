/**
 * Predicting a launch token's address before it exists.
 *
 * This is what lets a metadata pinning service authorize a write that has no on-chain
 * creator to check against yet: the address is a pure function of the salt, and `launch`
 * binds a salt's high 20 bytes to the sender. The failure being guarded is the CREATE2
 * `from`, because using the factory instead of `LaunchLib` produces a perfectly
 * plausible address rather than an error, and the mistake only surfaces as a launch that
 * reverts after the metadata has been pinned at an address that will never exist.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  getCreate2Address,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { launchCreate2Inputs, predictLaunchAddress } from "../src/launch";
import { packSalt, saltCreator } from "../src/salt";
import type { PublicClientLike } from "../src/types";

const FACTORY: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";
const LAUNCH_LIB: Address = "0x9A676e781A523b5d0C0e43731313A708CB607508";
const CREATOR: Address = "0xAebC4577f2DB3A819448d8e1779cfA851B5dbac0";
const STRANGER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const INIT_CODE_HASH: Hex = `0x${"ab".repeat(32)}`;

/** The two views, redeclared so the test decodes calldata independently of the source. */
const viewsAbi = [
  {
    type: "function",
    name: "tokenInitCodeHash",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "launchLib",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

function fakeFactory() {
  const calls: Array<{ to: Address; fn: string; args: readonly unknown[] }> = [];
  const client = createPublicClient({
    transport: custom({
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        if (method !== "eth_call") throw new Error(`unexpected RPC call: ${method}`);
        const { to, data } = params[0] as { to: Address; data: Hex };
        const decoded = decodeFunctionData({ abi: viewsAbi, data });
        calls.push({
          to,
          fn: decoded.functionName,
          args: (decoded.args ?? []) as readonly unknown[],
        });
        return decoded.functionName === "launchLib"
          ? encodeAbiParameters(parseAbiParameters("address"), [LAUNCH_LIB])
          : encodeAbiParameters(parseAbiParameters("bytes32"), [INIT_CODE_HASH]);
      },
    }),
  }) as PublicClientLike;
  return { client, calls };
}

describe("launchCreate2Inputs", () => {
  it("reads both values from the factory it was given", async () => {
    const { client, calls } = fakeFactory();
    const inputs = await launchCreate2Inputs(client, FACTORY, "Good Dog", "WOOF");

    expect(inputs).toEqual({ initCodeHash: INIT_CODE_HASH, deployer: LAUNCH_LIB });
    expect(calls.every((c) => c.to.toLowerCase() === FACTORY.toLowerCase())).toBe(true);
    expect([...calls.map((c) => c.fn)].sort()).toEqual(["launchLib", "tokenInitCodeHash"]);
  });

  it("hashes against the name and symbol it was given, since both move the address", async () => {
    const { client, calls } = fakeFactory();
    await launchCreate2Inputs(client, FACTORY, "Good Dog", "WOOF");

    const hash = calls.find((c) => c.fn === "tokenInitCodeHash");
    expect(hash?.args).toEqual(["Good Dog", "WOOF"]);
  });
});

describe("predictLaunchAddress", () => {
  it("builds the address from LaunchLib, not from the factory", async () => {
    const { client } = fakeFactory();
    const salt = packSalt(CREATOR, 42n);

    const predicted = await predictLaunchAddress(client, FACTORY, {
      salt,
      name: "Good Dog",
      symbol: "WOOF",
    });

    expect(predicted).toBe(
      getCreate2Address({ from: LAUNCH_LIB, salt, bytecodeHash: INIT_CODE_HASH }),
    );
    // The mistake this guards: same salt, same init code, wrong deployer, and an address
    // that looks entirely real.
    expect(predicted).not.toBe(
      getCreate2Address({ from: FACTORY, salt, bytecodeHash: INIT_CODE_HASH }),
    );
  });

  it("moves with the nonce, so one creator's two launches never collide", async () => {
    const { client } = fakeFactory();
    const params = { name: "Good Dog", symbol: "WOOF" } as const;

    const first = await predictLaunchAddress(client, FACTORY, {
      ...params,
      salt: packSalt(CREATOR, 1n),
    });
    const second = await predictLaunchAddress(client, FACTORY, {
      ...params,
      salt: packSalt(CREATOR, 2n),
    });

    expect(first).not.toBe(second);
  });

  it("moves with the creator, which is what makes it an authorization check", async () => {
    const { client } = fakeFactory();
    const params = { name: "Good Dog", symbol: "WOOF" } as const;

    // A stranger reusing the victim's nonce cannot land on the victim's address: the
    // creator is inside the salt, so a pin authorized on (saltCreator, predicted address)
    // can only ever be claimed by the account that can deploy there.
    const mine = await predictLaunchAddress(client, FACTORY, {
      ...params,
      salt: packSalt(CREATOR, 7n),
    });
    const theirs = await predictLaunchAddress(client, FACTORY, {
      ...params,
      salt: packSalt(STRANGER, 7n),
    });

    expect(mine).not.toBe(theirs);
    // `saltCreator` answers in lowercase, not checksummed, so a service comparing it to
    // an authenticated wallet has to fold case or it refuses every legitimate pin.
    expect(saltCreator(packSalt(CREATOR, 7n))).toBe(CREATOR.toLowerCase());
  });
});
