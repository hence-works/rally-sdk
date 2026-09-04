/**
 * Referrals are keyed differently per generation, and the wrong one does not degrade.
 *
 * v1 pools a referrer's earnings per QUOTE asset; protocol v2 accrues them per POOL. That
 * makes `referralFeesOwed(referrer, quote)` a selector on neither a v2 hook nor its fee
 * facet, so calling it there reverts `UnknownSelector` through the fallback instead of
 * answering zero. A venue reading the v1 shape on a v2 coin therefore sees an error it
 * cannot interpret, not an empty balance, which is what makes this worth pinning.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { rallyHookAbi, rallyHookU4Abi } from "../src/abis";
import { prepareClaimReferralFees, prepareClaimReferralOwed } from "../src/trade";
import type { RallyAddresses } from "../src/types";

const HOOK_V1: Address = "0x1111111111111111111111111111111111111111";
const HOOK_U4: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";
const WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const PID: Hex = `0x${"ab".repeat(32)}`;

const ADDRESSES = {
  chainId: 31337,
  deploymentBlock: 0,
  weth: WETH,
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  paramRegistry: "0x0B306BF915C4d645ff596e518fAf3F9669b97016",
  launchLib: "0x68B1D87F95878fE05B998F19b66F4baba5De1aed",
  launchHook: HOOK_V1,
  rallyFactory: "0xB237b78903C12B34F6cf099cf5ef701EF158BFE5",
  rallyRouter: "0x9A676e781A523b5d0C0e43731313A708CB607508",
} satisfies RallyAddresses;

describe("referral claim shapes", () => {
  it("v1 claims per quote asset", () => {
    const req = prepareClaimReferralFees(ADDRESSES, WETH, HOOK_V1);
    expect(req.to).toBe(HOOK_V1);
    const { functionName, args } = decodeFunctionData({ abi: rallyHookAbi, data: req.data });
    expect(functionName).toBe("claimReferralFees");
    expect(args).toEqual([WETH]);
  });

  it("v2 claims per pool, and targets that coin's own hook", () => {
    const req = prepareClaimReferralOwed(ADDRESSES, PID, HOOK_U4);
    // NOT the address set's current hook: referral balances live on the hook the coin
    // launched under, and a v2 coin's hook is never the chain's v1 one.
    expect(req.to).toBe(HOOK_U4);
    const { functionName, args } = decodeFunctionData({ abi: rallyHookU4Abi, data: req.data });
    expect(functionName).toBe("claimReferralFees");
    expect(args).toEqual([PID]);
  });

  it("the two encode to different selectors, so neither can stand in for the other", () => {
    const v1 = prepareClaimReferralFees(ADDRESSES, WETH, HOOK_V1).data.slice(0, 10);
    const v2 = prepareClaimReferralOwed(ADDRESSES, PID, HOOK_U4).data.slice(0, 10);
    expect(v1).not.toBe(v2);
  });

  it("neither ABI carries the other's referral surface", () => {
    const names = (abi: readonly unknown[]) =>
      abi.map((f) => (f as { name?: string }).name).filter(Boolean);
    // `referralFeesOwed` is v1's read and has no v2 counterpart by that name; a v2 hook
    // answers `referralOwed(pid, referrer)` instead.
    expect(names(rallyHookAbi)).toContain("referralFeesOwed");
    expect(names(rallyHookU4Abi)).not.toContain("referralFeesOwed");
    expect(names(rallyHookU4Abi)).toContain("referralOwed");
  });
});
