/**
 * @rally-fun/sdk — launch and trade Rally coins from any app.
 *
 * Rally is the programmable market layer for humans + agents, built as a Uniswap v4
 * hook: every trade settles through the v4 PoolManager, and a coin graduates
 * atomically into a permanently locked full-range v4 position. This package is the
 * headless client for it — no React, no wallet UI, no backend of its own.
 *
 *   import { createRallyClient } from "@rally-fun/sdk";
 *
 *   const rally = createRallyClient({ chainId, publicClient, walletClient });
 *   const { token } = await rally.launch({ name: "…", symbol: "…", metadataURI });
 *   const quote = await rally.quote(token, { side: "buy", amountIn: parseEther("0.1") });
 *   await rally.swap(token, { side: "buy", amountIn: parseEther("0.1") });
 *
 * Every write also has a `prepare*` form returning unsigned `{to, data, value}`, so
 * hosts that don't use viem for signing can submit transactions with their own stack.
 */

export { createRallyClient } from "./client";
export type { RallyClient, RallyClientConfig } from "./client";

export { RallyError, isRallyError } from "./errors";
export type { RallyErrorCode } from "./errors";

// Addresses & chains
export {
  ETH_ROUTES,
  ZERO_ADDRESS,
  defaultEthRoute,
  currentGeneration,
  generationForHook,
  generationsOf,
  getBundledAddresses,
  listSupportedChains,
  resolveAddresses,
  requireFactory,
} from "./addresses";
export { DEPLOYMENTS } from "./deployments";

// ABIs — exported so integrators can decode Rally logs or add calls the SDK lacks.
export {
  erc20Abi,
  rallyFactoryAbi,
  rallyFactoryU4Abi,
  rallyCurveShapesAbi,
  poolManagerAbi,
  rallyHookAbi,
  rallyHookU4Abi,
  rallyLensU4Abi,
  rallyParamRegistryAbi,
  rallyRouterAbi,
  rallyTokenAbi,
  rallyUniversalRouterAbi,
  uniswapV3PoolAbi,
} from "./abis";

// Pool identity
export {
  V4,
  decodeSlot0,
  poolIdFor,
  poolIdOf,
  poolKeyFor,
  poolStateSlot,
  priceWadFromSqrtPrice,
  sortCurrencies,
} from "./pool";
export type { PoolKey, Slot0 } from "./pool";

// Protocol v2 curve math. A v2 launch's curve IS Uniswap v4 liquidity, so it is priced by
// walking its position ladder rather than by the constant-product math in `./curve` —
// which applies to v1 and only to v1. `quoteTrade` picks the right one off
// `LaunchState.protocolVersion`; these are exported for hosts that want the pieces.
export {
  amount0Delta,
  curvePricePoints,
  amount1Delta,
  ladderAmount,
  liquidityAt,
  simulateSwap,
  sqrtPriceAtTick,
  tickMapOf,
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
} from "./clmm";
export type { CurvePricePoint, LadderPosition, SwapResult } from "./clmm";

// Salts and mining. `mineSalt` is exported so a host can grind off its own thread (a
// Worker, a worker pool, a backend job) and hand the result to `launch`/`prepareLaunch`
// as `salt`, which is the only way a slow grind stays off a UI thread: the launch
// helpers mine inline by design.
export { computeTokenAddress, packSalt, randomNonce, saltCreator } from "./salt";
export { mineSalt, selectMineEngine } from "./mine";
export type { MineEngine, MineSaltOptions } from "./mine";
export { mineSaltJs } from "./mine-core";
export type { MineOptions, MineResult } from "./mine-core";
export { isWasmMinerAvailable, mineSaltWasm } from "./mine-wasm";
export {
  MAX_SUFFIX_NIBBLES,
  parseSuffix,
  suffixAttempts,
  suffixMaxAttempts,
} from "./suffix";
export type { SaltSuffix } from "./suffix";

// Curve math — the on-chain bonding curve, ported exactly.
export {
  BPS,
  curveFeeBps,
  fdv,
  grossUpForFee,
  initCurve,
  lpSeed,
  previewBuy,
  previewBuyExactOut,
  previewSell,
  previewSellExactOut,
  pricePerTokenWad,
  quoteInForBuy,
  quoteOutForSell,
  curveTokenReserve,
  reserveX,
  reserveY,
  scaleFor,
  tokensInForSell,
  tokensOutForBuy,
} from "./curve";
export type {
  Curve,
  CurveCostPreview,
  CurveFeeParams,
  CurvePreview,
} from "./curve";

// Protocol v2 curve shapes: the preset table, and validating a shape of your own. The
// shape is frozen at launch, so these are the reads a host shows a creator BEFORE they
// commit to one.
export {
  CURVE_PRESETS,
  previewLaunchCurve,
  readCurveShapes,
  segmentsFromWeights,
  validateCurveSegments,
} from "./shapes";
export type { CurvePresetKey } from "./shapes";

// Governance params
export {
  REGISTRY_KEYS,
  readCurveParams,
  readFeePolicy,
  readParam,
  readParams,
} from "./params";
export type { RegistryKey } from "./params";

// Launching
export {
  parseLaunchReceipt,
  prepareLaunch,
  readQuoteConfig,
  validateFeeSplit,
  validateLaunchMetadataDocument,
  validateMetadataURI,
} from "./launch";
export type {
  LaunchParams,
  LaunchResult,
  PinLaunchMetadata,
  PreparedLaunch,
} from "./launch";

// Trading
export {
  APPROX_SLIPPAGE_BPS,
  DEFAULT_DEADLINE_SECONDS,
  EXACT_SLIPPAGE_BPS,
  applySlippage,
  chainDeadline,
  curveOf,
  prepareClaimReferralFees,
  prepareClaimReferralOwed,
  prepareEthBuy,
  quoteEthHop,
  prepareSwap,
  prepareSwapExactOut,
  quoteTrade,
  quoteTradeExactOut,
  readReferralFees,
  readReferralOwed,
  referralHookData,
  resolveLaunch,
  swapDeadline,
  toleranceFor,
} from "./trade";
export type {
  PrepareEthBuyParams,
  PrepareSwapExactOutParams,
  PrepareSwapParams,
  PreparedSwap,
  PreparedSwapExactOut,
  QuoteTradeExactOutParams,
  QuoteTradeParams,
} from "./trade";

// Trading a third-party launchpad's coin, through RallyUniversalRouter. A different
// contract from `rallyRouter` with different rules: it will not fill a Rally coin, and
// Rally's router will not fill a foreign one.
export {
  VENUE_KINDS,
  grossForNetRouteFee,
  netOfRouteFee,
  prepareVenueSwapCurve,
  prepareVenueSwapRoute,
  prepareVenueSwapV2,
  prepareVenueSwapV3,
  prepareVenueSwapV4,
  readRouteFeeBps,
  readVenuePaused,
  readVenueRoutable,
  routeLegCurve,
  routeLegV2,
  routeLegV3,
  routeLegV4,
  venueApprovalFor,
} from "./venue";
export type {
  PrepareVenueSwapCurveParams,
  PrepareVenueSwapPoolParams,
  PrepareVenueSwapRouteParams,
  PrepareVenueSwapV4Params,
  RouteLeg,
  VenueAllowlistQuery,
  VenueFill,
  VenueKind,
  VenueRouteFill,
} from "./venue";

// Metadata pinning
export { cleanMetadata, createRallyPinner } from "./metadata";
export type {
  AuthContext,
  MetadataConfig,
  MetadataPinner,
  PinInput,
  RallyPinner,
  SignMessageFn,
} from "./metadata";

// Shared types
export type {
  CurveParams,
  CurveSegment,
  CurveShapes,
  FeePolicy,
  FeeSplit,
  HookGeneration,
  LaunchGeneration,
  LaunchMetadata,
  LaunchMetadataParams,
  LaunchState,
  LaunchStep,
  LegacyDeployment,
  V2Deployment,
  Phase,
  PublicClientLike,
  QuoteConfig,
  RallyAddresses,
  SwapStep,
  TradeQuote,
  TradeQuoteExactOut,
  TradeSide,
  TxRequest,
  WalletClientLike,
} from "./types";
