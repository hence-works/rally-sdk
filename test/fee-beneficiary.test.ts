import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { rallyFeeBeneficiaryAbi } from "../src/abis";
import { generationForHook, generationsOf } from "../src/addresses";
import { DEPLOYMENTS } from "../src/deployments";
import {
  getFeeBeneficiary,
  prepareRegisterFeeBeneficiary,
  prepareTransferFeeRight,
  registerFeeBeneficiary,
  transferFeeRight,
} from "../src/feebeneficiary";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../rally-protocol/deployments");
const files = readdirSync(manifests).filter((f) => /^\d+\.json$/.test(f) && f !== "31337.json");

const PID: Hex = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const ME: Address = getAddress("0x00000000000000000000000000000000000000a1");
const SPLITTER: Address = getAddress("0x00000000000000000000000000000000000000b2");

describe("sync:deployments carries the fee beneficiary", () => {
  it("--check passes, so the bundle covers the key", () => {
    execFileSync(process.execPath, [resolve(here, "../scripts/sync-deployments.mjs"), "--check"], { stdio: "pipe" });
  });

  it("every V2Deployments entry of all six manifests lands in the bundle, per generation", () => {
    expect(files).toHaveLength(6);
    let seen = 0;
    for (const f of files) {
      const chainId = Number(f.split(".")[0]);
      const m = JSON.parse(readFileSync(join(manifests, f), "utf8"));
      for (const g of m.V2Deployments ?? []) {
        const gen = generationForHook(DEPLOYMENTS[chainId]!, g.LaunchHook);
        expect(gen, `${chainId} ${g.LaunchHook}`).toBeDefined();
        expect(gen!.protocolVersion).toBe(2);
        expect(gen!.feeBeneficiary).toBe(g.FeeBeneficiary);
        expect(gen!.feeBeneficiaryBlock).toBe(g.FeeBeneficiaryBlock);
        seen++;
      }
    }
    expect(seen).toBe(12);
  });
});

describe("generation resolution on 4663", () => {
  const a = DEPLOYMENTS[4663]!;
  const ACTIVE: Address = "0x173604A8292eEF32de51Dd9E30144fCE5530E8CC";
  const PRE_RENAME_HOOK: Address = "0xA460135240c99A903Ab2e259FF1Bde955CA9E8CC";

  it("active generation", () => {
    const g = generationForHook(a, ACTIVE)!;
    expect(g.status).toBe("active");
    expect(g.feeBeneficiary).toBe("0x02f7E1d61B214EbCFd52AcaEe00FCa5B37A18F4f");
  });

  it("retired generation, matched case-insensitively", () => {
    const g = generationForHook(a, "0x369fc170b278a71b07c6c34249b52d6a76f9a8cc")!;
    expect(g.status).toBe("retired");
    expect(g.feeBeneficiary).toBe("0xA6f475911D31749002AC46faA2B57Fa9E247673c");
  });

  it("the pre-rename build (hook() instead of backend()) resolves, and is read without backend()", async () => {
    const g = generationForHook(a, PRE_RENAME_HOOK)!;
    expect(g.status).toBe("retired");
    expect(g.feeBeneficiary).toBe("0xF66372154B51dAc65bcE26D4f6a80ca8A11518a8");
    const calls: Hex[] = [];
    const client = mockClient((to, data) => {
      calls.push(data);
      expect(to.toLowerCase()).toBe("0xf66372154b51dac65bce26d4f6a80ca8a11518a8");
      return holder(ME);
    });
    const r = await getFeeBeneficiary(client, { chainId: 4663, hook: PRE_RENAME_HOOK, pid: PID });
    expect(r).toMatchObject({ supported: true, registered: true, holder: ME });
    // Exactly one call, and it is beneficiaryOf.
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: rallyFeeBeneficiaryAbi, data: calls[0] as Hex }).functionName).toBe("beneficiaryOf");
  });

  it("protocol v1 hooks are unsupported, not guessed", async () => {
    const v1 = generationsOf(a).find((g) => g.protocolVersion === 1)!;
    const client = mockClient(() => {
      throw new Error("must not read");
    });
    expect(await getFeeBeneficiary(client, { chainId: 4663, hook: v1.launchHook, pid: PID })).toMatchObject({ supported: false });
    expect(() => prepareRegisterFeeBeneficiary({ chainId: 4663, hook: v1.launchHook, pid: PID })).toThrowError(/no fee beneficiary/);
  });

  it("an unknown hook and a missing hook are errors", async () => {
    const hook = "0x0000000000000000000000000000000000000dEa" as Address;
    expect(() => prepareRegisterFeeBeneficiary({ chainId: 4663, hook, pid: PID })).toThrowError(/not a known generation/);
    expect(() => prepareRegisterFeeBeneficiary({ chainId: 4663, pid: PID })).toThrowError(/hook/);
    expect(() => prepareRegisterFeeBeneficiary({ chainId: 4663, launch: { hook: ACTIVE }, pid: PID })).not.toThrow();
  });
});

describe("getFeeBeneficiary", () => {
  const hook: Address = "0x173604A8292eEF32de51Dd9E30144fCE5530E8CC";
  it("unregistered reads as holder null: fees go to the original creator", async () => {
    const client = mockClient(() => holder("0x0000000000000000000000000000000000000000"));
    expect(await getFeeBeneficiary(client, { chainId: 4663, hook, pid: PID })).toEqual({
      supported: true,
      beneficiary: "0x02f7E1d61B214EbCFd52AcaEe00FCa5B37A18F4f",
      registered: false,
      holder: null,
    });
  });
  it("registered reads as the holder", async () => {
    const client = mockClient(() => holder(SPLITTER));
    expect(await getFeeBeneficiary(client, { chainId: 4663, hook, pid: PID })).toMatchObject({ registered: true, holder: SPLITTER });
  });
});

describe("calldata", () => {
  const hook: Address = "0x173604A8292eEF32de51Dd9E30144fCE5530E8CC";
  const target = "0x02f7E1d61B214EbCFd52AcaEe00FCa5B37A18F4f";

  it("register(pid)", () => {
    const t = prepareRegisterFeeBeneficiary({ chainId: 4663, hook, pid: PID });
    expect(t).toMatchObject({ to: target, value: 0n, chainId: 4663 });
    expect(decodeFunctionData({ abi: rallyFeeBeneficiaryAbi, data: t.data })).toEqual({ functionName: "register", args: [PID] });
  });

  it("safeTransferFrom(from, to, id) by default, id = the pool id as uint256", () => {
    const t = prepareTransferFeeRight({ chainId: 4663, hook, pid: PID, from: ME, to: SPLITTER });
    expect(t.to).toBe(target);
    const d = decodeFunctionData({ abi: rallyFeeBeneficiaryAbi, data: t.data });
    expect(d.functionName).toBe("safeTransferFrom");
    expect(d.args).toEqual([ME, SPLITTER, BigInt(PID)]);
    // 4-byte selector of safeTransferFrom(address,address,uint256)
    expect(t.data.slice(0, 10)).toBe("0x42842e0e");
  });

  it("transferFrom is the fallback for a receiver without onERC721Received", () => {
    const t = prepareTransferFeeRight({ chainId: 4663, hook, pid: PID, from: ME, to: SPLITTER, safe: false });
    expect(t.data.slice(0, 10)).toBe("0x23b872dd");
    expect(decodeFunctionData({ abi: rallyFeeBeneficiaryAbi, data: t.data }).args).toEqual([ME, SPLITTER, BigInt(PID)]);
  });

  it("the one-call forms reject NO_WALLET without a wallet client", async () => {
    const publicClient = mockClient(() => holder(ME));
    await expect(registerFeeBeneficiary({ publicClient }, { chainId: 4663, hook, pid: PID })).rejects.toMatchObject({ code: "NO_WALLET" });
    await expect(transferFeeRight({ publicClient }, { chainId: 4663, hook, pid: PID, to: SPLITTER })).rejects.toMatchObject({ code: "NO_WALLET" });
  });
});

// ── helpers ──
function holder(a: string): Hex {
  return encodeFunctionResult({ abi: rallyFeeBeneficiaryAbi, functionName: "beneficiaryOf", result: a as Address });
}
function mockClient(answer: (to: Address, data: Hex) => Hex) {
  return createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_call") {
          const { to, data } = (params as [{ to: Address; data: Hex }])[0];
          return answer(to, data);
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
}
