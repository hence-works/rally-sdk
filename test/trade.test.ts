/**
 * Exact-OUTPUT swaps: the three things that flip relative to exact-input, each of which
 * is a revert or an unfillable trade on-chain rather than a merely-wrong number.
 *
 *   - `amountSpecified` must be POSITIVE, since that sign is what makes v4 read the
 *     swap as exact-output at all;
 *   - `amountLimit` becomes a MAXIMUM INPUT, and `0` no longer opts out: every input
 *     exceeds 0, so a zero limit reverts `ExcessiveInput` every time; and
 *   - the allowance and a `payWithEth` buy's `msg.value` must cover `maxAmountIn`, not
 *     the estimate, or the trade fails exactly when the price moved in the direction the
 *     bound exists to tolerate.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
} from "viem";
import { erc20Abi, rallyRouterAbi } from "../src/abis";
import { poolIdFor, poolKeyFor, sortCurrencies } from "../src/pool";
import { prepareSwapExactOut } from "../src/trade";
import { RallyError } from "../src/errors";
import type { CurveParams, LaunchState, PublicClientLike, RallyAddresses } from "../src/types";

const WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const TOKEN: Address = "0x1f60EBa664cb43348a91a50dbcACAE0aDD7a595f";
const HOOK: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";
const ROUTER: Address = "0x9A676e781A523b5d0C0e43731313A708CB607508";
const TRADER: Address = "0xAebC4577f2DB3A819448d8e1779cfA851B5dbac0";

const ADDRESSES: RallyAddresses = {
  chainId: 31337,
  deploymentBlock: 0,
  weth: WETH,
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  paramRegistry: "0x0B306BF915C4d645ff596e518fAf3F9669b97016",
  launchLib: "0x68B1D87F95878fE05B998F19b66F4baba5De1aed",
  launchHook: HOOK,
  rallyFactory: "0xB237b78903C12B34F6cf099cf5ef701EF158BFE5",
  rallyRouter: ROUTER,
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
/** Well past the anti-snipe decay window, so the fee is pinned at its floor. */
const AT_TIME = LAUNCHED_AT + 3_600;
const ONE_MILLION = 1_000_000n * 10n ** 18n;

function launchState(over: Partial<LaunchState> = {}): LaunchState {
  const poolKey = poolKeyFor(WETH, TOKEN, HOOK);
  return {
    token: TOKEN,
    pid: poolIdFor(poolKey),
    quote: {
      address: WETH,
      allowed: true,
      decimals: 18,
      gradThreshold: B,
      launchFee: 0n,
      scale: 10n ** 18n,
      isNative: true,
    },
    phase: "CURVE",
    bonded: 0n,
    gradThreshold: B,
    launchedAt: LAUNCHED_AT,
    graduatedAt: 0,
    poolPriceWad: 0n,
    reserves: { quote: 0n, token: PARAMS.curveAllocation },
    feeSplit: { creatorBps: 10_000, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
    quoteIsCurrency0: sortCurrencies(WETH, TOKEN).quoteIsCurrency0,
    poolKey,
    ...over,
  };
}

/** A client whose only answer is the ERC-20 allowance the prepare path reads. */
function clientWithAllowance(allowance: bigint): PublicClientLike {
  return createPublicClient({
    transport: custom({
      async request({ method }: { method: string }) {
        if (method !== "eth_call") throw new Error(`unexpected RPC call: ${method}`);
        return encodeAbiParameters(parseAbiParameters("uint256"), [allowance]);
      },
    }),
  });
}

/** The router `swap` args, positionally: key, params, hookData, unwrapOut, limit, deadline. */
function decodeSwap(data: `0x${string}`) {
  const decoded = decodeFunctionData({ abi: rallyRouterAbi, data });
  expect(decoded.functionName).toBe("swap");
  const args = decoded.args as readonly [
    unknown,
    { zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint },
    `0x${string}`,
    boolean,
    bigint,
    bigint,
  ];
  return { params: args[1], unwrapOut: args[3], amountLimit: args[4], deadline: args[5] };
}

describe("prepareSwapExactOut", () => {
  it("encodes a POSITIVE amountSpecified equal to the wanted output", async () => {
    const prepared = await prepareSwapExactOut(
      clientWithAllowance(0n),
      ADDRESSES,
      launchState(),
      PARAMS,
      { side: "buy", amountOut: ONE_MILLION, trader: TRADER, atTime: AT_TIME },
    );

    const { params } = decodeSwap(prepared.request.data);
    expect(params.amountSpecified > 0n).toBe(true);
    expect(params.amountSpecified).toBe(ONE_MILLION);
    // Buying: the quote is the input leg, so direction follows how it sorted.
    expect(params.zeroForOne).toBe(sortCurrencies(WETH, TOKEN).quoteIsCurrency0);
    expect(prepared.zeroForOne).toBe(params.zeroForOne);
  });

  it("submits maxAmountIn as the amountLimit, and never 0", async () => {
    const prepared = await prepareSwapExactOut(
      clientWithAllowance(0n),
      ADDRESSES,
      launchState(),
      PARAMS,
      { side: "buy", amountOut: ONE_MILLION, trader: TRADER, atTime: AT_TIME },
    );

    const { amountLimit } = decodeSwap(prepared.request.data);
    expect(prepared.quote.amountIn > 0n).toBe(true);
    // A ceiling on the input: widened by the tolerance, not cut by it.
    expect(prepared.quote.maxAmountIn > prepared.quote.amountIn).toBe(true);
    expect(amountLimit).toBe(prepared.quote.maxAmountIn);
    expect(amountLimit).not.toBe(0n);
    expect(prepared.quote.slippageBps).toBe(100n);
  });

  it("rejects a 0 maxAmountIn instead of emitting an always-reverting swap", async () => {
    // On exact-input, 0 opts out. On exact-output it makes the router's check
    // unsatisfiable, so every such swap reverts ExcessiveInput.
    await expect(
      prepareSwapExactOut(clientWithAllowance(0n), ADDRESSES, launchState(), PARAMS, {
        side: "buy",
        amountOut: ONE_MILLION,
        trader: TRADER,
        atTime: AT_TIME,
        maxAmountIn: 0n,
      }),
    ).rejects.toThrow(/ExcessiveInput/);
  });

  it("sizes the approval to maxAmountIn, not to the estimate", async () => {
    const launch = launchState();
    const prepared = await prepareSwapExactOut(clientWithAllowance(0n), ADDRESSES, launch, PARAMS, {
      side: "buy",
      amountOut: ONE_MILLION,
      trader: TRADER,
      atTime: AT_TIME,
    });

    expect(prepared.approval).toBeDefined();
    const approval = decodeFunctionData({ abi: erc20Abi, data: prepared.approval!.data });
    expect(approval.functionName).toBe("approve");
    const [spender, amount] = approval.args as readonly [Address, bigint];
    expect(spender).toBe(ROUTER);
    // An approval for `amountIn` bricks the trade at exactly the limit it authorised.
    expect(amount).toBe(prepared.quote.maxAmountIn);
    expect(amount > prepared.quote.amountIn).toBe(true);
    expect(prepared.approval!.to).toBe(WETH);
  });

  it("skips the approval once the allowance already covers maxAmountIn", async () => {
    const generous = 10n ** 30n;
    const prepared = await prepareSwapExactOut(
      clientWithAllowance(generous),
      ADDRESSES,
      launchState(),
      PARAMS,
      { side: "buy", amountOut: ONE_MILLION, trader: TRADER, atTime: AT_TIME },
    );
    expect(prepared.approval).toBeUndefined();
  });

  it("sends maxAmountIn as msg.value on a payWithEth buy, and needs no approval", async () => {
    const prepared = await prepareSwapExactOut(
      clientWithAllowance(0n),
      ADDRESSES,
      launchState(),
      PARAMS,
      { side: "buy", amountOut: ONE_MILLION, trader: TRADER, atTime: AT_TIME, payWithEth: true },
    );

    // The router wraps msg.value, spends what the swap costs and refunds the rest, so the
    // ceiling is the only safe amount to attach.
    expect(prepared.request.value).toBe(prepared.quote.maxAmountIn);
    expect(prepared.request.value > prepared.quote.amountIn).toBe(true);
    expect(prepared.approval).toBeUndefined();
    expect(prepared.request.to).toBe(ROUTER);
  });

  it("leaves value at 0 and unwraps a wETH sell payout by default", async () => {
    // A sell needs a bonded reserve to pay out of; `reserves.token` 0 falls back to the
    // K/X(b) reconstruction, which is what an indexed row would supply.
    const bonded = launchState({ bonded: 2n * 10n ** 18n, reserves: { quote: 2n * 10n ** 18n, token: 0n } });
    const prepared = await prepareSwapExactOut(clientWithAllowance(0n), ADDRESSES, bonded, PARAMS, {
      side: "sell",
      amountOut: 10n ** 17n,
      trader: TRADER,
      atTime: AT_TIME,
    });

    expect(prepared.request.value).toBe(0n);
    expect(decodeSwap(prepared.request.data).unwrapOut).toBe(true);
    // Selling spends the token, so that is the leg needing the allowance.
    expect(prepared.approval!.to).toBe(TOKEN);
  });

  it("throws UNSUPPORTED on a graduated launch rather than mispricing a transaction", async () => {
    const graduated = launchState({ phase: "GRADUATED", graduatedAt: LAUNCHED_AT + 60 });
    const call = prepareSwapExactOut(clientWithAllowance(0n), ADDRESSES, graduated, PARAMS, {
      side: "buy",
      amountOut: ONE_MILLION,
      trader: TRADER,
      atTime: AT_TIME,
    });

    await expect(call).rejects.toThrow(RallyError);
    await expect(call).rejects.toThrow(/curve-phase only/);
    await expect(call).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("rejects a non-positive amountOut", async () => {
    await expect(
      prepareSwapExactOut(clientWithAllowance(0n), ADDRESSES, launchState(), PARAMS, {
        side: "buy",
        amountOut: 0n,
        trader: TRADER,
        atTime: AT_TIME,
      }),
    ).rejects.toThrow(/amountOut must be greater than zero/);
  });

  it("refuses payWithEth on a launch that is not wETH-quoted", async () => {
    const usdcQuoted = launchState({
      quote: {
        address: ADDRESSES.usdc,
        allowed: true,
        decimals: 6,
        gradThreshold: 5_000_000_000n,
        launchFee: 0n,
        scale: 10n ** 30n,
        isNative: false,
      },
      gradThreshold: 5_000_000_000n,
    });
    await expect(
      prepareSwapExactOut(clientWithAllowance(0n), ADDRESSES, usdcQuoted, PARAMS, {
        side: "buy",
        amountOut: ONE_MILLION,
        trader: TRADER,
        atTime: AT_TIME,
        payWithEth: true,
      }),
    ).rejects.toThrow(/prepareEthBuy/);
  });
});
