/**
 * @rally-fun/sdk — launch and trade Rally coins from any app.
 *
 * Rally is a memecoin launchpad built as a Uniswap v4 hook: a virtual bonding curve
 * that graduates atomically into a locked CLMM pool. This package is the headless
 * client for it — no React, no wallet UI, no backend of its own.
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
  poolManagerAbi,
  rallyHookAbi,
  rallyParamRegistryAbi,
  rallyRouterAbi,
  rallyTokenAbi,
  uniswapV3PoolAbi,
} from "./abis";

// Pool identity
export { V4, poolIdFor, poolIdOf, poolKeyFor, sortCurrencies } from "./pool";
export type { PoolKey } from "./pool";

// Salts & vanity mining
export {
  compileVanity,
  computeTokenAddress,
  formatVanity,
  matchesVanity,
  packSalt,
  saltCreator,
  vanityDifficulty,
} from "./salt";
export type { CompiledVanity, Vanity } from "./salt";
export {
  isWasmMinerAvailable,
  loadVanityWasm,
  mineVanitySalt,
  mineVanitySaltJs,
  mineVanitySaltWasm,
} from "./mine";
export type { MineEngine, MineOptions, MineOutcome, MineResult } from "./mine";

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
export type { Curve, CurveCostPreview, CurveFeeParams, CurvePreview } from "./curve";

// Governance params
export { REGISTRY_KEYS, readCurveParams, readFeePolicy, readParam, readParams } from "./params";
export type { RegistryKey } from "./params";

// Launching
export {
  parseLaunchReceipt,
  prepareLaunch,
  readQuoteConfig,
  readTokenVanity,
  validateFeeSplit,
  validateLaunchMetadataDocument,
  validateMetadataURI,
} from "./launch";
export type { LaunchParams, LaunchResult, PinLaunchMetadata, PreparedLaunch } from "./launch";

// Trading
export {
  APPROX_SLIPPAGE_BPS,
  DEFAULT_DEADLINE_SECONDS,
  EXACT_SLIPPAGE_BPS,
  applySlippage,
  chainDeadline,
  curveOf,
  prepareClaimReferralFees,
  prepareEthBuy,
  quoteEthHop,
  prepareSwap,
  prepareSwapExactOut,
  quoteTrade,
  quoteTradeExactOut,
  readReferralFees,
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
  FeePolicy,
  FeeSplit,
  HookGeneration,
  LaunchGeneration,
  LaunchMetadata,
  LaunchMetadataParams,
  LaunchState,
  LaunchStep,
  LegacyDeployment,
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
