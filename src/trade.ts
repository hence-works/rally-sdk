/**
 * Reading a launch and trading it.
 *
 * Two things make this different from quoting a plain AMM, and both feed the slippage
 * bound rather than being cosmetic:
 *
 *   - the anti-snipe curve fee decays 25% → 1% over the launch window, so a quote is
 *     only valid for the fee at execution time; and
 *   - a buy large enough to bond `b` to `B` **graduates the launch mid-swap** and pays
 *     its remainder against a CLMM pool that did not exist when we quoted it.
 *
 * So a non-crossing curve trade is priced exactly (the math here mirrors
 * `LaunchCurve`) and gets a tight band, while a crossing buy or a graduated pool is an
 * approximation and gets a wider one. `TradeQuote.exact` says which you got.
 *
 * Approximate does not mean impact-free: a graduated pool is priced against its real
 * reserves, because a launch graduates with only `B` of quote behind it and a large exit
 * is a majority-impact trade there. Quoting such a pool off spot produces a slippage
 * bound the router cannot satisfy, which presents to the user as an unsellable position
 * rather than as a bad price.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import { readContract } from "viem/actions";
import { erc20Abi, rallyHookAbi, rallyRouterAbi, uniswapV3PoolAbi } from "./abis";
import { RallyError } from "./errors";
import { poolIdFor, poolKeyFor, sortCurrencies, V4, type PoolKey } from "./pool";
import {
  clmmAmountOut,
  curveFeeBps,
  initCurve,
  curveTokenReserve,
  previewBuy,
  previewBuyExactOut,
  previewSell,
  previewSellExactOut,
  pricePerTokenWad,
  scaleFor,
  type Curve,
} from "./curve";
import type {
  CurveParams,
  LaunchState,
  Phase,
  PublicClientLike,
  QuoteConfig,
  RallyAddresses,
  TradeQuote,
  TradeQuoteExactOut,
  TradeSide,
  TxRequest,
} from "./types";

const BPS = 10_000n;
const PHASES: Phase[] = ["NONE", "CURVE", "GRADUATED"];

/** `type(uint256).max`: an unlimited ERC-20 approval, and the router's exact-out opt-out. */
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * 1% — the estimate came from an exact curve preview, so this only absorbs the fee
 * decay and other traders moving `b` between quote and inclusion.
 */
export const EXACT_SLIPPAGE_BPS = 100n;
/**
 * 5% — the estimate is approximate: a graduation-crossing buy, or a graduated pool. Both
 * carry their own price impact now (see {clmmAmountOut}), so this is no longer covering
 * for an estimate that ignored slippage entirely; it absorbs other traders moving the pool
 * between quote and inclusion, plus the small residual from modelling a finite-range
 * position as a constant product.
 */
export const APPROX_SLIPPAGE_BPS = 500n;

export function toleranceFor(exact: boolean): bigint {
  return exact ? EXACT_SLIPPAGE_BPS : APPROX_SLIPPAGE_BPS;
}

/** Apply a bps tolerance to an estimate. Returns 0 when there is nothing to bound. */
export function applySlippage(estimate: bigint, bps: bigint): bigint {
  if (estimate <= 0n || bps >= BPS) return 0n;
  return (estimate * (BPS - bps)) / BPS;
}

/** A deadline `secondsFromNow` ahead of now, for the router's `deadline` argument. */
export function swapDeadline(secondsFromNow = 600): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow);
}

/**
 * Find which allowlisted quote a token launched against, then read its full state.
 *
 * A third-party venue knows a token address, not a PoolId — and the PoolId depends on
 * the quote. Rather than requiring an indexer round-trip, this derives the candidate
 * PoolId locally for each known quote and asks the hook which one exists. With two
 * allowlisted quotes that is two `eth_call`s and no external dependency.
 */
export async function resolveLaunch(
  client: PublicClientLike,
  addresses: RallyAddresses,
  token: Address,
  candidateQuotes: Address[],
  quoteConfig: (quote: Address) => Promise<QuoteConfig>,
): Promise<LaunchState> {
  const candidates = candidateQuotes.map((quote) => ({
    quote,
    key: poolKeyFor(quote, token, addresses.launchHook),
  }));
  const phases = await Promise.all(
    candidates.map(({ key }) =>
      readContract(client, {
        address: addresses.launchHook,
        abi: rallyHookAbi,
        functionName: "phaseOf",
        args: [poolIdFor(key)],
      }).catch(() => 0),
    ),
  );

  const found = candidates.findIndex((_, i) => Number(phases[i]) !== 0);
  if (found === -1) {
    throw new RallyError(
      "LAUNCH_NOT_FOUND",
      `No Rally launch for ${token} against any known quote on chain ${addresses.chainId}. ` +
        `Tried: ${candidateQuotes.join(", ")}. If it launched against a newer quote, add it ` +
        `via \`quotes\` on createRallyClient.`,
      { details: { token, candidateQuotes } },
    );
  }

  const { quote: quoteAddress, key } = candidates[found]!;
  const pid = poolIdFor(key);
  const phase = PHASES[Number(phases[found])] ?? "NONE";

  const [quote, bonded, gradThreshold, launchedAt, graduatedAt, poolPriceWad, reserves, feeSplit] =
    await Promise.all([
      quoteConfig(quoteAddress),
      read(client, addresses.launchHook, "bonded", pid),
      read(client, addresses.launchHook, "gradThreshold", pid),
      read(client, addresses.launchHook, "launchedAt", pid),
      read(client, addresses.launchHook, "graduatedAt", pid),
      read(client, addresses.launchHook, "poolPriceWad", pid),
      readContract(client, {
        address: addresses.launchHook,
        abi: rallyHookAbi,
        functionName: "poolReserves",
        args: [pid],
      }),
      readContract(client, {
        address: addresses.launchHook,
        abi: rallyHookAbi,
        functionName: "feeConfigOf",
        args: [pid],
      }),
    ]);

  return {
    token,
    pid,
    quote,
    phase,
    bonded: bonded as bigint,
    gradThreshold: gradThreshold as bigint,
    launchedAt: Number(launchedAt),
    graduatedAt: Number(graduatedAt),
    poolPriceWad: poolPriceWad as bigint,
    reserves: { quote: reserves[0], token: reserves[1] },
    feeSplit: {
      creatorBps: feeSplit.creatorBps,
      dividendBps: feeSplit.dividendBps,
      buybackBps: feeSplit.buybackBps,
      lpSupportBps: feeSplit.lpSupportBps,
    },
    quoteIsCurrency0: sortCurrencies(quoteAddress, token).quoteIsCurrency0,
    poolKey: key,
  };
}

function read(
  client: PublicClientLike,
  hook: Address,
  functionName: "bonded" | "gradThreshold" | "launchedAt" | "graduatedAt" | "poolPriceWad",
  pid: Hex,
) {
  return readContract(client, { address: hook, abi: rallyHookAbi, functionName, args: [pid] });
}

/** Rebuild the launch's curve from the registry params + its own `B`. */
export function curveOf(launch: LaunchState, params: CurveParams): Curve | null {
  return initCurve(params.totalSupply, params.curveAllocation, launch.gradThreshold);
}

export interface QuoteTradeParams {
  side: TradeSide;
  /** Exact-input amount, in the input leg's base units. */
  amountIn: bigint;
  /** Override the slippage tolerance in bps. Defaults to 1% exact / 5% approximate. */
  slippageBps?: bigint;
  /** Unix seconds to price the anti-snipe fee at. Defaults to now. */
  atTime?: number;
}

/**
 * Price a trade off the curve, with no RPC beyond the state already read.
 *
 * During CURVE this reproduces `LaunchCurve` exactly. Post-graduation the curve prices
 * nothing, so the estimate comes from the locked position's own reserves via
 * {clmmAmountOut} — which means it includes the trade's price impact. It stays
 * `exact: false` (a full-range position is not precisely `xy = k`) and keeps the wider
 * tolerance, but the number shown is now the number the pool will actually pay.
 */
export function quoteTrade(
  launch: LaunchState,
  params: CurveParams,
  input: QuoteTradeParams,
): TradeQuote {
  const { side, amountIn } = input;
  if (amountIn <= 0n) {
    throw new RallyError("INVALID_AMOUNT", "amountIn must be greater than zero.");
  }

  const now = input.atTime ?? Math.floor(Date.now() / 1000);
  const onCurve = launch.phase === "CURVE";
  const curve = onCurve ? curveOf(launch, params) : null;
  const feeBps = onCurve
    ? curveFeeBps(
        {
          startBps: params.feeStartBps,
          endBps: params.feeEndBps,
          decay: params.feeDecaySeconds,
        },
        launch.launchedAt,
        now,
      )
    : 0n;

  let amountOut: bigint;
  let feeQuote = 0n;
  let crossesGraduation = false;
  let exact = false;

  // The curve's token reserve: stored on-chain and returned by `poolReserves` during
  // CURVE, so an estimate matches the fill exactly. Falls back to the `K/X(b)`
  // reconstruction for adapted state — see {curveTokenReserve}.
  const curveY = curve ? curveTokenReserve(curve, launch.bonded, launch.reserves.token) : 0n;

  if (curve) {
    const preview =
      side === "buy"
        ? previewBuy(curve, launch.bonded, curveY, amountIn, feeBps, params.poolFeeBps)
        : previewSell(curve, launch.bonded, curveY, amountIn, feeBps);
    amountOut = preview.amountOut;
    feeQuote = preview.feeQuote;
    crossesGraduation = preview.crossesGraduation;
    exact = !preview.crossesGraduation;
  } else {
    // Graduated: price against the locked position's real reserves, so the estimate
    // carries the trade's own price impact. See {clmmAmountOut} for why spot is not
    // usable here — a graduated pool holds only `B` of quote, so an exit sized like a
    // creator's stack moves the price a long way, and a bound derived from spot is
    // simply unreachable.
    const { quote: quoteReserve, token: tokenReserve } = launch.reserves;
    if (quoteReserve <= 0n || tokenReserve <= 0n) {
      throw new RallyError(
        "NO_PRICE",
        `No liquidity available for ${launch.token} — the pool has graduated but reports ` +
          `an empty reserve (quote ${quoteReserve}, token ${tokenReserve}). Refusing to ` +
          `quote a trade that cannot be bounded.`,
        {
          details: {
            token: launch.token,
            phase: launch.phase,
            quoteReserve,
            tokenReserve,
          },
        },
      );
    }
    // The hook's post-graduation fee is always quote-denominated, so it comes off the
    // INPUT on a buy and off the OUTPUT on a sell — hence the direction flag.
    amountOut =
      side === "buy"
        ? clmmAmountOut(amountIn, quoteReserve, tokenReserve, params.poolFeeBps, true)
        : clmmAmountOut(amountIn, tokenReserve, quoteReserve, params.poolFeeBps, false);
  }

  const priceWad = curve
    ? pricePerTokenWad(curve, launch.bonded, scaleFor(launch.quote.decimals))
    : launch.poolPriceWad;
  const slippageBps = input.slippageBps ?? toleranceFor(exact);

  return {
    side,
    amountIn,
    amountOut,
    minAmountOut: applySlippage(amountOut, slippageBps),
    slippageBps,
    feeBps,
    feeQuote,
    priceWad,
    crossesGraduation,
    exact,
    phase: launch.phase,
  };
}

export interface QuoteTradeExactOutParams {
  side: TradeSide;
  /** Exact-output amount, in the output leg's base units. */
  amountOut: bigint;
  /** Override the slippage tolerance in bps. Defaults to 1% exact / 5% approximate. */
  slippageBps?: bigint;
  /** Unix seconds to price the anti-snipe fee at. Defaults to now. */
  atTime?: number;
}

/** Exact-output pricing: what `wantOut` will cost. Curve phase only. */
export function quoteTradeExactOut(
  launch: LaunchState,
  params: CurveParams,
  input: QuoteTradeExactOutParams,
): TradeQuoteExactOut {
  const curve = launch.phase === "CURVE" ? curveOf(launch, params) : null;
  if (!curve) {
    throw new RallyError(
      "UNSUPPORTED",
      "Exact-output quoting is curve-phase only. A graduated pool needs a v4 quoter.",
      { details: { phase: launch.phase } },
    );
  }
  const now = input.atTime ?? Math.floor(Date.now() / 1000);
  const feeBps = curveFeeBps(
    { startBps: params.feeStartBps, endBps: params.feeEndBps, decay: params.feeDecaySeconds },
    launch.launchedAt,
    now,
  );

  const preview =
    input.side === "buy"
      ? previewBuyExactOut(
          curve,
          launch.bonded,
          curveTokenReserve(curve, launch.bonded, launch.reserves.token),
          input.amountOut,
          feeBps,
          params.poolFeeBps,
        )
      : previewSellExactOut(
          curve,
          launch.bonded,
          curveTokenReserve(curve, launch.bonded, launch.reserves.token),
          input.amountOut,
          feeBps,
        );

  if (!preview) {
    throw new RallyError(
      "INVALID_AMOUNT",
      `Cannot withdraw ${input.amountOut} quote: it exceeds the curve's bonded reserve ` +
        `(${launch.bonded}). On-chain this reverts ExactOutputExceedsReserve.`,
      { details: { bonded: launch.bonded, wanted: input.amountOut } },
    );
  }

  const slippageBps = input.slippageBps ?? toleranceFor(!preview.crossesGraduation);
  return {
    amountIn: preview.amountIn,
    // Exact-out bounds the INPUT from above, so the tolerance widens rather than cuts.
    maxAmountIn: (preview.amountIn * (BPS + slippageBps)) / BPS,
    feeQuote: preview.feeQuote,
    crossesGraduation: preview.crossesGraduation,
    slippageBps,
  };
}

export interface PrepareSwapParams extends QuoteTradeParams {
  /** The trader. Needed only to check the allowance for the input leg. */
  trader?: Address;
  /** Override the computed `amountLimit` (the router's slippage bound). */
  minAmountOut?: bigint;
  /** Unix-seconds deadline. Defaults to 10 minutes out. */
  deadline?: bigint;
  /**
   * Fund a wETH-quoted buy with native ETH (`msg.value`, wrapped by the router and the
   * remainder refunded) instead of a wETH allowance. Defaults to false — pass true
   * when the trader holds ETH rather than wETH.
   */
  payWithEth?: boolean;
  /**
   * Deliver a wETH output leg as native ETH. Defaults to true for a sell into a
   * wETH-quoted pool, which is what a user holding ETH expects.
   */
  unwrapOut?: boolean;
  /** Approve `type(uint256).max` instead of the exact input. Default false. */
  approveMax?: boolean;
}

export interface PreparedSwap {
  quote: TradeQuote;
  /** Present when the input leg needs an allowance to the router. */
  approval?: TxRequest;
  request: TxRequest;
  poolKey: PoolKey;
  zeroForOne: boolean;
  deadline: bigint;
}

/**
 * Build an unsigned swap through `RallyRouter.swap`.
 *
 * Trades route through the router — never `PoolManager` directly — because v4's own
 * `Swap` event records only the router as `sender`; the router re-emits `RallySwap`
 * with the real trader, which is what attributes the fill to a user downstream.
 */
export async function prepareSwap(
  client: PublicClientLike,
  addresses: RallyAddresses,
  launch: LaunchState,
  params: CurveParams,
  input: PrepareSwapParams,
): Promise<PreparedSwap> {
  const quote = quoteTrade(launch, params, input);
  const buy = input.side === "buy";
  const inputToken = buy ? launch.quote.address : launch.token;
  const payWithEth = Boolean(input.payWithEth) && buy && launch.quote.isNative;
  const unwrapOut = input.unwrapOut ?? (!buy && launch.quote.isNative);

  if (input.payWithEth && !launch.quote.isNative) {
    throw new RallyError(
      "INVALID_AMOUNT",
      `payWithEth only works on a wETH-quoted launch. ${launch.token} is quoted in ` +
        `${launch.quote.address}. Use prepareEthBuy, which routes ETH through a v3 pool first.`,
      { details: { quote: launch.quote.address } },
    );
  }

  let approval: TxRequest | undefined;
  if (!payWithEth) {
    const trader = input.trader;
    if (!trader) {
      throw new RallyError(
        "NO_ACCOUNT",
        "Pass `trader` (or use a client with an account) so the input allowance can be checked.",
      );
    }
    const allowance = await readContract(client, {
      address: inputToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [trader, addresses.rallyRouter],
    });
    if (allowance < input.amountIn) {
      approval = {
        to: inputToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.rallyRouter, input.approveMax ? MAX_UINT256 : input.amountIn],
        }),
        value: 0n,
        chainId: addresses.chainId,
      };
    }
  }

  // Buys spend the quote, sells spend the token — direction follows from which side
  // the quote sorted onto.
  const zeroForOne = buy ? launch.quoteIsCurrency0 : !launch.quoteIsCurrency0;
  const deadline = input.deadline ?? swapDeadline();
  const amountLimit = input.minAmountOut ?? quote.minAmountOut;

  const data = encodeFunctionData({
    abi: rallyRouterAbi,
    functionName: "swap",
    args: [
      launch.poolKey,
      {
        zeroForOne,
        // Negative = exact input, per v4's sign convention.
        amountSpecified: -input.amountIn,
        sqrtPriceLimitX96: zeroForOne ? V4.MIN_SQRT_RATIO + 1n : V4.MAX_SQRT_RATIO - 1n,
      },
      "0x",
      unwrapOut,
      amountLimit,
      deadline,
    ],
  });

  return {
    quote,
    approval,
    request: {
      to: addresses.rallyRouter,
      data,
      value: payWithEth ? input.amountIn : 0n,
      chainId: addresses.chainId,
    },
    poolKey: launch.poolKey,
    zeroForOne,
    deadline,
  };
}

export interface PrepareSwapExactOutParams extends QuoteTradeExactOutParams {
  /** The trader. Needed only to check the allowance for the input leg. */
  trader?: Address;
  /**
   * Override the computed `amountLimit`: here a CEILING on the input, not a floor on
   * the output. It is also what the approval is sized to, and what a `payWithEth` buy
   * attaches as `msg.value`, so raising it raises both. `0` is rejected: on an
   * exact-output swap it makes the router's check unsatisfiable rather than opting out.
   */
  maxAmountIn?: bigint;
  /** Unix-seconds deadline. Defaults to 10 minutes out. */
  deadline?: bigint;
  /**
   * Fund a wETH-quoted buy with native ETH (`msg.value`, wrapped by the router and the
   * remainder refunded) instead of a wETH allowance. Defaults to false; pass true
   * when the trader holds ETH rather than wETH.
   */
  payWithEth?: boolean;
  /**
   * Deliver a wETH output leg as native ETH. Defaults to true for a sell into a
   * wETH-quoted pool, which is what a user holding ETH expects.
   */
  unwrapOut?: boolean;
  /** Approve `type(uint256).max` instead of the exact worst-case input. Default false. */
  approveMax?: boolean;
}

export interface PreparedSwapExactOut {
  quote: TradeQuoteExactOut;
  /** Present when the input leg needs an allowance to the router. */
  approval?: TxRequest;
  request: TxRequest;
  poolKey: PoolKey;
  zeroForOne: boolean;
  deadline: bigint;
}

/**
 * Build an unsigned exact-OUTPUT swap through `RallyRouter.swap` ("buy exactly 1M
 * tokens", "sell into exactly 0.5 wETH"): the transaction twin of {quoteTradeExactOut}.
 *
 * Three things flip relative to {prepareSwap}, and getting any of them wrong is a
 * revert or a bricked trade rather than a bad price:
 *
 *   - `amountSpecified` is POSITIVE. v4 reads the sign as the direction, so `+amountOut`
 *     is what makes this exact-output at all.
 *   - `amountLimit` becomes a MAXIMUM INPUT (`_checkLimit`'s else branch). The opt-out
 *     value flips with it: exact-input opts out with `0`, exact-output with
 *     `type(uint256).max`. `0` here is not "no bound": every input exceeds 0, so the
 *     swap always reverts `ExcessiveInput`. This never emits it.
 *   - the allowance, and a `payWithEth` buy's `msg.value`, must cover `maxAmountIn`,
 *     not `amountIn`. The router pulls what the swap actually costs, up to the limit;
 *     sizing either to the estimate means the trade fails exactly when the price moved
 *     in the way the bound exists to tolerate. Over-sent ETH comes back: the router
 *     refunds the wrap its input leg did not consume.
 *
 * Curve phase only, matching {quoteTradeExactOut}: a graduated pool needs a v4 quoter,
 * and building a transaction off a price we cannot compute would just mislead.
 */
export async function prepareSwapExactOut(
  client: PublicClientLike,
  addresses: RallyAddresses,
  launch: LaunchState,
  params: CurveParams,
  input: PrepareSwapExactOutParams,
): Promise<PreparedSwapExactOut> {
  if (input.amountOut <= 0n) {
    throw new RallyError("INVALID_AMOUNT", "amountOut must be greater than zero.");
  }

  // Throws UNSUPPORTED on a graduated launch, before anything is built.
  const quote = quoteTradeExactOut(launch, params, input);

  const buy = input.side === "buy";
  const inputToken = buy ? launch.quote.address : launch.token;
  const payWithEth = Boolean(input.payWithEth) && buy && launch.quote.isNative;
  const unwrapOut = input.unwrapOut ?? (!buy && launch.quote.isNative);

  if (input.payWithEth && !launch.quote.isNative) {
    throw new RallyError(
      "INVALID_AMOUNT",
      `payWithEth only works on a wETH-quoted launch. ${launch.token} is quoted in ` +
        `${launch.quote.address}. Use prepareEthBuy, which routes ETH through a v3 pool first.`,
      { details: { quote: launch.quote.address } },
    );
  }

  // The ceiling the router may pull. Everything downstream is sized to this, not to the
  // estimate: the estimate is what we expect to pay, this is what we have authorised.
  const maxAmountIn = input.maxAmountIn ?? quote.maxAmountIn;
  if (maxAmountIn <= 0n) {
    throw new RallyError(
      "INVALID_AMOUNT",
      "maxAmountIn must be greater than zero on an exact-output swap. Unlike exact-input, " +
        "0 does not opt out of the bound: it makes the router's check unsatisfiable and " +
        "the swap always reverts ExcessiveInput. Opt out with 2n ** 256n - 1n if you " +
        "really mean unbounded.",
      { details: { maxAmountIn, amountIn: quote.amountIn } },
    );
  }

  let approval: TxRequest | undefined;
  if (!payWithEth) {
    const trader = input.trader;
    if (!trader) {
      throw new RallyError(
        "NO_ACCOUNT",
        "Pass `trader` (or use a client with an account) so the input allowance can be checked.",
      );
    }
    const allowance = await readContract(client, {
      address: inputToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [trader, addresses.rallyRouter],
    });
    if (allowance < maxAmountIn) {
      approval = {
        to: inputToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.rallyRouter, input.approveMax ? MAX_UINT256 : maxAmountIn],
        }),
        value: 0n,
        chainId: addresses.chainId,
      };
    }
  }

  // Buys spend the quote, sells spend the token, so direction follows from which side
  // the quote sorted onto. Identical to the exact-input path: the sign of
  // `amountSpecified` chooses exact-in vs exact-out, `zeroForOne` chooses the leg.
  const zeroForOne = buy ? launch.quoteIsCurrency0 : !launch.quoteIsCurrency0;
  const deadline = input.deadline ?? swapDeadline();

  const data = encodeFunctionData({
    abi: rallyRouterAbi,
    functionName: "swap",
    args: [
      launch.poolKey,
      {
        zeroForOne,
        // Positive = exact output, per v4's sign convention.
        amountSpecified: input.amountOut,
        sqrtPriceLimitX96: zeroForOne ? V4.MIN_SQRT_RATIO + 1n : V4.MAX_SQRT_RATIO - 1n,
      },
      "0x",
      unwrapOut,
      maxAmountIn,
      deadline,
    ],
  });

  return {
    quote,
    approval,
    request: {
      to: addresses.rallyRouter,
      data,
      // Send the ceiling, not the estimate: the router wraps `msg.value`, spends what the
      // swap costs and refunds the rest, so under-sending is the only way to fail here.
      value: payWithEth ? maxAmountIn : 0n,
      chainId: addresses.chainId,
    },
    poolKey: launch.poolKey,
    zeroForOne,
    deadline,
  };
}

export interface PrepareEthBuyParams {
  /** ETH to spend, in wei. */
  amountIn: bigint;
  /**
   * The wETH/quote Uniswap **v3** pool to route through. Defaults to the SDK's known
   * route for this chain and quote. Caller-supplied by design: the router holds no
   * venue config, so a bad route can only hurt the caller — and is bounded by
   * `minAmountOut` end-to-end.
   */
  v3Pool?: Address;
  /**
   * Minimum launch tokens out across BOTH legs. Required — this path is exposed to v3
   * pool depth on top of the curve fee decay, and `0` opts out of protection entirely.
   */
  minAmountOut: bigint;
  /** Optional floor on the ETH→quote leg alone. `amountLimit` is the one that matters. */
  minQuoteOut?: bigint;
  deadline?: bigint;
}

/**
 * Buy a launch quoted in something the trader doesn't hold (USDC, …) paying entirely in
 * native ETH: `RallyRouter.swapExactEthIn` wraps `msg.value`, sells it for the quote on
 * a Uniswap v3 pool, then spends the whole proceeds on the curve — one transaction, no
 * approvals.
 *
 * The v3 pool is validated here (its `token0`/`token1` must be exactly the wETH/quote
 * pair) so a wrong route fails before signing rather than as an opaque `BadV3Pool`.
 * Exact-input buys only; there is no ETH-funded sell.
 */
export async function prepareEthBuy(
  client: PublicClientLike,
  addresses: RallyAddresses,
  launch: LaunchState,
  input: PrepareEthBuyParams,
  defaultRoute?: Address,
): Promise<{ request: TxRequest; v3Pool: Address; deadline: bigint; zeroForOne: boolean }> {
  if (launch.quote.isNative) {
    throw new RallyError(
      "UNSUPPORTED",
      "This launch is wETH-quoted — use prepareSwap({ payWithEth: true }), which needs no v3 hop.",
    );
  }
  if (input.amountIn <= 0n) {
    throw new RallyError("INVALID_AMOUNT", "amountIn (ETH) must be greater than zero.");
  }
  if (input.minAmountOut <= 0n) {
    throw new RallyError(
      "INVALID_AMOUNT",
      "minAmountOut is required for an ETH-routed buy: it is the only bound across both " +
        "the v3 hop and the curve, and 0 opts out of slippage protection entirely.",
    );
  }

  const v3Pool = input.v3Pool ?? defaultRoute;
  if (!v3Pool) {
    throw new RallyError(
      "NO_ETH_ROUTE",
      `No known wETH/${launch.quote.address} v3 pool on chain ${addresses.chainId}. ` +
        `Pass \`v3Pool\` explicitly.`,
      { details: { chainId: addresses.chainId, quote: launch.quote.address } },
    );
  }

  const [token0, token1] = await Promise.all([
    readContract(client, { address: v3Pool, abi: uniswapV3PoolAbi, functionName: "token0" }),
    readContract(client, { address: v3Pool, abi: uniswapV3PoolAbi, functionName: "token1" }),
  ]);
  const pair = [token0.toLowerCase(), token1.toLowerCase()];
  const wanted = [addresses.weth.toLowerCase(), launch.quote.address.toLowerCase()];
  if (!wanted.every((a) => pair.includes(a))) {
    throw new RallyError(
      "BAD_ETH_ROUTE",
      `${v3Pool} is a ${token0}/${token1} pool, not wETH/${launch.quote.address}. ` +
        `The router rejects it (BadV3Pool).`,
      { details: { v3Pool, token0, token1 } },
    );
  }

  const zeroForOne = launch.quoteIsCurrency0; // buying: the quote leg is the input
  const deadline = input.deadline ?? swapDeadline();
  return {
    v3Pool,
    deadline,
    zeroForOne,
    request: {
      to: addresses.rallyRouter,
      data: encodeFunctionData({
        abi: rallyRouterAbi,
        functionName: "swapExactEthIn",
        args: [
          launch.poolKey,
          zeroForOne,
          "0x",
          v3Pool,
          input.minQuoteOut ?? 0n,
          input.minAmountOut,
          deadline,
        ],
      }),
      value: input.amountIn,
      chainId: addresses.chainId,
    },
  };
}
