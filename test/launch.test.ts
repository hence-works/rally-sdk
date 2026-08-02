/**
 * Guards on the two things a caller can get wrong in a way the chain only catches
 * after they have already paid for a grind and a metadata pin.
 */
import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Address } from "viem";
import { parseLaunchReceipt, validateFeeSplit } from "../src/launch";
import { applySlippage, toleranceFor, EXACT_SLIPPAGE_BPS, APPROX_SLIPPAGE_BPS } from "../src/trade";
import { RallyError } from "../src/errors";
import type { FeePolicy } from "../src/types";

const OPEN: FeePolicy = {
  platformBps: 2_500,
  creatorCapBps: 10_000,
  mechanismMask: 7,
  dividendEnabled: true,
  buybackEnabled: true,
  lpSupportEnabled: true,
};

describe("validateFeeSplit", () => {
  it("accepts a split that sums to 10000", () => {
    expect(() =>
      validateFeeSplit(
        { creatorBps: 5_000, dividendBps: 5_000, buybackBps: 0, lpSupportBps: 0 },
        OPEN,
      ),
    ).not.toThrow();
  });

  it("rejects a split that doesn't sum to 10000", () => {
    expect(() =>
      validateFeeSplit({ creatorBps: 100, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 }, OPEN),
    ).toThrow(RallyError);
  });

  it("rejects a creator share over the governance cap", () => {
    const capped: FeePolicy = { ...OPEN, creatorCapBps: 8_000 };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 10_000, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
        capped,
      ),
    ).toThrow(/exceeds the governance cap/);
  });

  it("rejects a mechanism governance has switched off", () => {
    const noBuyback: FeePolicy = { ...OPEN, mechanismMask: 5, buybackEnabled: false };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 5_000, dividendBps: 0, buybackBps: 5_000, lpSupportBps: 0 },
        noBuyback,
      ),
    ).toThrow(/buyback/);
  });

  it("allows a zero share in a disabled mechanism", () => {
    const noBuyback: FeePolicy = { ...OPEN, mechanismMask: 5, buybackEnabled: false };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 10_000, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
        noBuyback,
      ),
    ).not.toThrow();
  });
});

describe("parseLaunchReceipt", () => {
  const HOOK: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";

  it("treats a mined-but-reverted transaction as a failure", () => {
    // waitForTransactionReceipt resolves for a reverted tx too — inclusion is not success.
    const receipt = { status: "reverted", logs: [], transactionHash: keccak256(toHex("x")) };
    expect(() => parseLaunchReceipt(receipt as never, HOOK)).toThrow(/reverted on-chain/);
  });

  it("errors clearly when no Launched event came from the expected hook", () => {
    const receipt = { status: "success", logs: [], transactionHash: keccak256(toHex("x")) };
    expect(() => parseLaunchReceipt(receipt as never, HOOK)).toThrow(/No Launched event/);
  });

  // The first buy's amounts come from `RallyFactory.FirstBuy` and from nowhere else. The
  // v4 `Swap` the same buy triggers has BOTH legs zero — a curve fill is answered entirely
  // by the hook's `BeforeSwapDelta`, so v4 moves no liquidity — which is why reading the
  // `Swap` left `firstBuyTokens` permanently undefined.
  const FACTORY: Address = "0xB237b78903C12B34F6cf099cf5ef701EF158BFE5";
  const POOL_MANAGER: Address = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";
  const PID = keccak256(toHex("pid"));
  const TOKEN: Address = "0x1f60EBa664cb43348a91a50dbcACAE0aDD7a595f";
  const CREATOR: Address = "0xAebC4577f2DB3A819448d8e1779cfA851B5dbac0";
  const WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

  /** wETH < token here, so currency0 is the quote: creator pays leg0, receives leg1. */
  const SPENT = 1_000_000_000_000_000_000n;
  const RECEIVED = 4_200_000_000_000_000_000_000n;

  function receiptWith(logs: unknown[]) {
    return { status: "success", logs, transactionHash: keccak256(toHex("x")) } as never;
  }

  it("reads the first buy from FirstBuy, not from the zero-legged v4 Swap", async () => {
    const { encodeAbiParameters, encodeEventTopics, parseAbiParameters } = await import("viem");
    const { rallyFactoryAbi, rallyHookAbi, poolManagerAbi } = await import("../src/abis");

    const logs = [
      {
        address: HOOK,
        topics: encodeEventTopics({
          abi: rallyHookAbi,
          eventName: "Launched",
          args: { pid: PID, token: TOKEN, creator: CREATOR },
        }),
        data: encodeAbiParameters(parseAbiParameters("address, uint256, string"), [
          WETH,
          5_000_000_000_000_000_000n,
          "ipfs://meta",
        ]),
      },
      // The v4 Swap the first buy triggers: real, and structurally empty.
      {
        address: POOL_MANAGER,
        topics: encodeEventTopics({
          abi: poolManagerAbi,
          eventName: "Swap",
          args: { id: PID, sender: FACTORY },
        }),
        data: encodeAbiParameters(
          parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"),
          [0n, 0n, 79228162514264337593543950336n, 0n, 0, 0],
        ),
      },
      {
        address: FACTORY,
        topics: encodeEventTopics({
          abi: rallyFactoryAbi,
          eventName: "FirstBuy",
          args: { pid: PID, buyer: CREATOR },
        }),
        data: encodeAbiParameters(parseAbiParameters("int128, int128, uint160, int24"), [
          -SPENT,
          RECEIVED,
          79228162514264337593543950336n,
          0,
        ]),
      },
    ];

    const parsed = parseLaunchReceipt(receiptWith(logs), HOOK, FACTORY);
    expect(parsed.token).toBe(TOKEN);
    expect(parsed.firstBuyTokens).toBe(RECEIVED);

    // Without the factory there is nothing to read it from — the Swap cannot supply it.
    expect(parseLaunchReceipt(receiptWith(logs), HOOK).firstBuyTokens).toBeUndefined();
  });
});

describe("slippage bounds", () => {
  it("bounds an exact curve estimate tightly and an approximate one loosely", () => {
    expect(toleranceFor(true)).toBe(EXACT_SLIPPAGE_BPS);
    expect(toleranceFor(false)).toBe(APPROX_SLIPPAGE_BPS);
    expect(applySlippage(1_000n, 100n)).toBe(990n);
    expect(applySlippage(1_000n, 500n)).toBe(950n);
  });

  it("returns 0 when there is nothing to bound rather than inventing a floor", () => {
    expect(applySlippage(0n, 100n)).toBe(0n);
    expect(applySlippage(1_000n, 10_000n)).toBe(0n);
  });
});
