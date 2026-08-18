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
 *
 * Plus the two ways an exact-INPUT swap can go out unprotected without anyone asking:
 * a `0` limit, which the router reads as an opt-out rather than as a bound, and a
 * deadline measured against a clock that is not the chain's.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
} from "viem";
import { erc20Abi, rallyHookAbi, rallyRouterAbi } from "../src/abis";
import { poolIdFor, poolKeyFor, sortCurrencies } from "../src/pool";
import {
  DEFAULT_DEADLINE_SECONDS,
  prepareClaimReferralFees,
  prepareSwap,
  prepareSwapExactOut,
  referralHookData,
} from "../src/trade";
import { RallyError } from "../src/errors";
import type { CurveParams, LaunchState, PublicClientLike, RallyAddresses } from "../src/types";

const WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const TOKEN: Address = "0x1f60EBa664cb43348a91a50dbcACAE0aDD7a595f";
const HOOK: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";
const ROUTER: Address = "0x9A676e781A523b5d0C0e43731313A708CB607508";
const TRADER: Address = "0xAebC4577f2DB3A819448d8e1779cfA851B5dbac0";
/** A third-party venue naming itself as the referrer on the swaps it places. */
const VENUE: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

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
    hook: HOOK,
    router: ROUTER,
    factory: ADDRESSES.rallyFactory,
    paramRegistry: ADDRESSES.paramRegistry,
    ...over,
  };
}

/** Chain time in the mocks below. Deliberately nowhere near the local clock. */
const CHAIN_NOW = 1_900_000_000n;

/**
 * A client answering the two reads a prepare path makes: the ERC-20 allowance, and the
 * latest block, whose timestamp is what the deadline is measured from.
 */
function clientWithAllowance(allowance: bigint, chainNow = CHAIN_NOW): PublicClientLike {
  return createPublicClient({
    transport: custom({
      async request({ method }: { method: string }) {
        if (method === "eth_getBlockByNumber") {
          return {
            number: "0x1",
            timestamp: `0x${chainNow.toString(16)}`,
            hash: `0x${"11".repeat(32)}`,
            parentHash: `0x${"00".repeat(32)}`,
            transactions: [],
          };
        }
        if (method !== "eth_call") throw new Error(`unexpected RPC call: ${method}`);
        return encodeAbiParameters(parseAbiParameters("uint256"), [allowance]);
      },
    }),
  });
}

/** A client whose node cannot serve a block header, but can still answer a call. */
function clientWithoutBlocks(allowance: bigint): PublicClientLike {
  return createPublicClient({
    transport: custom({
      async request({ method }: { method: string }) {
        if (method !== "eth_call") throw new Error(`node is not serving ${method}`);
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
  return {
    params: args[1],
    hookData: args[2],
    unwrapOut: args[3],
    amountLimit: args[4],
    deadline: args[5],
  };
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

  // Live reserves captured from a real graduated pool (see curve.test.ts for the
  // provenance): the estimate must carry the trade's own price impact.
  const GRAD_RESERVES = {
    quote: 836740873017552922n, // 0.83674 wETH
    token: 191218100082752180896397374n, // 191.218M tokens
  };
  const graduatedState = (over: Partial<LaunchState> = {}) =>
    launchState({
      phase: "GRADUATED",
      graduatedAt: LAUNCHED_AT + 60,
      bonded: B,
      reserves: GRAD_RESERVES,
      ...over,
    });

  it("prices a graduated buy off the pool's real reserves, with the wider band", async () => {
    const prepared = await prepareSwapExactOut(
      clientWithAllowance(0n),
      ADDRESSES,
      graduatedState(),
      PARAMS,
      { side: "buy", amountOut: ONE_MILLION, trader: TRADER, atTime: AT_TIME },
    );

    // An approximate estimate, so it takes the 5% default and says so.
    expect(prepared.quote.exact).toBe(false);
    expect(prepared.quote.slippageBps).toBe(500n);
    expect(prepared.quote.phase).toBe("GRADUATED");
    expect(prepared.quote.amountIn > 0n).toBe(true);

    const { params, amountLimit } = decodeSwap(prepared.request.data);
    expect(params.amountSpecified).toBe(ONE_MILLION);
    expect(amountLimit).toBe(prepared.quote.maxAmountIn);

    // The fee is the hook's POOL_FEE_BPS grossed up on the pool's required input, so
    // the total is strictly more than the fee-free constant-product inverse.
    const denom = GRAD_RESERVES.token - ONE_MILLION;
    const poolIn = (GRAD_RESERVES.quote * ONE_MILLION + denom - 1n) / denom;
    expect(prepared.quote.amountIn - prepared.quote.feeQuote).toBe(poolIn);
    expect(prepared.quote.feeQuote > 0n).toBe(true);
  });

  it("prices a graduated sell so the trader nets exactly the wanted quote", async () => {
    const wantQuote = GRAD_RESERVES.quote / 100n;
    const prepared = await prepareSwapExactOut(
      clientWithAllowance(0n),
      ADDRESSES,
      graduatedState(),
      PARAMS,
      { side: "sell", amountOut: wantQuote, trader: TRADER, atTime: AT_TIME },
    );

    // The pool must produce the grossed-up output; the hook keeps the difference. The
    // fee is therefore a function of the WANTED amount alone, not of the token input.
    const gross = (wantQuote * 10_000n + (10_000n - PARAMS.poolFeeBps) - 1n) / (10_000n - PARAMS.poolFeeBps);
    expect(prepared.quote.feeQuote).toBe(gross - wantQuote);
    // Selling spends the token, so that is the leg needing the allowance.
    expect(prepared.approval!.to).toBe(TOKEN);
    expect(decodeSwap(prepared.request.data).unwrapOut).toBe(true);
  });

  it("throws NO_PRICE on a graduated launch whose reserves are missing", async () => {
    const call = prepareSwapExactOut(
      clientWithAllowance(0n),
      ADDRESSES,
      graduatedState({ reserves: { quote: 0n, token: 0n } }),
      PARAMS,
      { side: "buy", amountOut: ONE_MILLION, trader: TRADER, atTime: AT_TIME },
    );
    await expect(call).rejects.toThrow(RallyError);
    await expect(call).rejects.toMatchObject({ code: "NO_PRICE" });
  });

  it("throws INVALID_AMOUNT when no reserve can pay the wanted output", async () => {
    const call = prepareSwapExactOut(
      clientWithAllowance(0n),
      ADDRESSES,
      graduatedState(),
      PARAMS,
      { side: "sell", amountOut: GRAD_RESERVES.quote, trader: TRADER, atTime: AT_TIME },
    );
    await expect(call).rejects.toThrow(RallyError);
    await expect(call).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
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

describe("prepareSwap (exact input)", () => {
  const BUY = { side: "buy", amountIn: 10n ** 17n, trader: TRADER, atTime: AT_TIME } as const;

  it("submits the quote's minAmountOut as the amountLimit", async () => {
    const prepared = await prepareSwap(
      clientWithAllowance(0n),
      ADDRESSES,
      launchState(),
      PARAMS,
      BUY,
    );

    const { amountLimit, params } = decodeSwap(prepared.request.data);
    expect(params.amountSpecified).toBe(-BUY.amountIn); // negative = exact input
    expect(prepared.quote.minAmountOut > 0n).toBe(true);
    expect(prepared.quote.minAmountOut < prepared.quote.amountOut).toBe(true);
    expect(amountLimit).toBe(prepared.quote.minAmountOut);
  });

  it("refuses to build an unbounded swap when the trade prices at zero output", async () => {
    // `0` is the router's opt-out on exact-input (_checkLimit skips the comparison), so a
    // quote that cannot be priced must fail here rather than go out as a market order.
    await expect(
      prepareSwap(clientWithAllowance(0n), ADDRESSES, launchState(), PARAMS, {
        ...BUY,
        slippageBps: 10_000n,
      }),
    ).rejects.toThrow(/slippage bound/);
  });

  it("still lets a caller opt out of the bound deliberately", async () => {
    const prepared = await prepareSwap(clientWithAllowance(0n), ADDRESSES, launchState(), PARAMS, {
      ...BUY,
      minAmountOut: 0n,
    });
    expect(decodeSwap(prepared.request.data).amountLimit).toBe(0n);
  });

  it("measures the deadline from chain time, not the local clock", async () => {
    const prepared = await prepareSwap(
      clientWithAllowance(0n),
      ADDRESSES,
      launchState(),
      PARAMS,
      BUY,
    );

    // The router compares against `block.timestamp`. A local clock running behind would
    // put this in the past and revert DeadlineExpired on every trade from that machine.
    expect(prepared.deadline).toBe(CHAIN_NOW + BigInt(DEFAULT_DEADLINE_SECONDS));
    expect(decodeSwap(prepared.request.data).deadline).toBe(prepared.deadline);
  });

  it("honours deadlineSeconds against chain time", async () => {
    const prepared = await prepareSwap(clientWithAllowance(0n), ADDRESSES, launchState(), PARAMS, {
      ...BUY,
      deadlineSeconds: 120,
    });
    expect(prepared.deadline).toBe(CHAIN_NOW + 120n);
  });

  it("keeps an explicit deadline exactly as passed", async () => {
    const prepared = await prepareSwap(clientWithAllowance(0n), ADDRESSES, launchState(), PARAMS, {
      ...BUY,
      deadline: 42n,
    });
    expect(prepared.deadline).toBe(42n);
  });

  it("leaves hookData empty when no referrer is named", async () => {
    const prepared = await prepareSwap(
      clientWithAllowance(0n),
      ADDRESSES,
      launchState(),
      PARAMS,
      BUY,
    );
    expect(decodeSwap(prepared.request.data).hookData).toBe("0x");
  });

  it("encodes a referrer into hookData as the hook expects", async () => {
    const prepared = await prepareSwap(clientWithAllowance(0n), ADDRESSES, launchState(), PARAMS, {
      ...BUY,
      referrer: VENUE,
    });

    const { hookData } = decodeSwap(prepared.request.data);
    // 32 bytes, left-padded: the hook decodes exactly this shape and reverts BadHookData
    // on anything else, so the length is as load-bearing as the value.
    expect(hookData).toBe(referralHookData(VENUE));
    expect((hookData.length - 2) / 2).toBe(32);
    expect(decodeAbiParameters([{ type: "address" }], hookData)[0]).toBe(VENUE);
  });

  it("treats the zero referrer as no referral rather than as 32 zero bytes", async () => {
    const prepared = await prepareSwap(clientWithAllowance(0n), ADDRESSES, launchState(), PARAMS, {
      ...BUY,
      referrer: "0x0000000000000000000000000000000000000000",
    });
    expect(decodeSwap(prepared.request.data).hookData).toBe("0x");
  });

  it("falls back to the local clock when the node cannot serve a block", async () => {
    const prepared = await prepareSwap(
      clientWithoutBlocks(0n),
      ADDRESSES,
      launchState(),
      PARAMS,
      BUY,
    );

    // A node that cannot answer a block header should not be the reason a trade cannot
    // be built: degrade to the old behaviour rather than throw.
    const localNow = BigInt(Math.floor(Date.now() / 1000));
    const expected = localNow + BigInt(DEFAULT_DEADLINE_SECONDS);
    expect(prepared.deadline >= expected - 5n).toBe(true);
    expect(prepared.deadline <= expected + 5n).toBe(true);
  });
});

describe("prepareClaimReferralFees", () => {
  it("targets the hook and names no recipient", () => {
    const request = prepareClaimReferralFees(ADDRESSES, WETH);

    expect(request.to).toBe(HOOK);
    expect(request.value).toBe(0n);
    expect(request.chainId).toBe(ADDRESSES.chainId);

    const decoded = decodeFunctionData({ abi: rallyHookAbi, data: request.data });
    expect(decoded.functionName).toBe("claimReferralFees");
    // The quote is the only argument: the hook pays `msg.sender`, so the signer IS the
    // recipient and there is no address here to get wrong.
    expect(decoded.args).toEqual([WETH]);
  });
});
