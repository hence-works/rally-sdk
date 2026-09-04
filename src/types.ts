/**
 * Public types. Kept in one module so integrators can import the shape of anything
 * the SDK returns without reaching into implementation files.
 */
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import type { LadderPosition } from "./clmm";

export type { LadderPosition };

/**
 * The contract set for one chain. Bundled per-chain (see `deployments.ts`) and
 * overridable through `createRallyClient({ addresses })` — a local anvil deploy or a
 * chain whose manifest isn't in this SDK version yet only needs the overrides.
 */
export interface RallyAddresses {
  chainId: number;
  /** First block of the deployment — a useful `fromBlock` floor for log scans. */
  deploymentBlock: number;
  /** Wrapped native token; the quote that can be funded with plain ETH. */
  weth: Address;
  usdc: Address;
  poolManager: Address;
  paramRegistry: Address;
  /** CREATE2 deployer of launch tokens — the `from` salt mining must use. */
  launchLib: Address;
  launchHook: Address;
  /** Absent on chains deployed before the creation path split out of the hook. */
  rallyFactory?: Address;
  rallyRouter: Address;
  /**
   * The entrypoint for trading a coin launched on a THIRD-PARTY launchpad we list, where
   * `rallyRouter` above serves only coins launched here. Absent on a chain that lists no
   * external venue.
   *
   * Chain level and not per generation: it is a proxy whose address never changes, and it
   * is periphery that no hook points at, so a launch generation rotating leaves it alone.
   *
   * Which venues it will fill is an on-chain allowlist rather than an address here, and a
   * coin whose venue was never allowlisted is unroutable rather than mis-routed.
   */
  universalRouter?: Address;
  /**
   * Resolves a Pons v2 coin to the per-coin bonding curve that fills it, for the universal
   * router's curve path. Pons specific by construction: a venue that launches straight into
   * a pool has a venue hook on the router but no curve and therefore no resolver.
   */
  ponsV2CurveResolver?: Address;
  dividendDistributor?: Address;
  /**
   * Where the hook sends the platform's fee cut. Absent on a chain deployed against a bare
   * EOA treasury — permanently, since `treasury` is immutable on both the hook and factory.
   */
  rallyVault?: Address;
  /**
   * Prize escrow for the daily draw. Additive, so absence means gacha isn't deployed on this
   * chain rather than anything being wrong.
   */
  gachaVault?: Address;
  /**
   * Entrypoint for trading a THIRD-PARTY launchpad's coin through Rally. `rallyRouter`
   * above serves only Rally's own coins and this one is refused them, so a host listing
   * both kinds needs both addresses.
   *
   * Always the PROXY, and the address never moves: a new implementation is an upgrade
   * from the router's owner rather than a redeploy, because traders hold ERC-20
   * approvals against it. Absent on a chain with no external venues, which is the
   * signal that aggregated trading is simply off there.
   */
  rallyUniversalRouter?: Address;
  /**
   * Resolves a Pons v2 coin to the bonding curve that fills it, for
   * {@link rallyUniversalRouter}'s `swapCurve` path. Venue specific by construction, so
   * a venue that launches straight into a pool has a hook on the allowlist and no
   * resolver here. Absent means curve-phase coins on that venue cannot be routed.
   */
  ponsV2CurveResolver?: Address;
  /**
   * Every PREVIOUS hook generation still live on this chain, newest first.
   *
   * A v4 hook address is part of every PoolKey, so a protocol redeploy cannot migrate
   * existing pools: a coin launched under an older hook stays bound to that hook, its
   * factory and its router forever, and keeps trading there. The top-level `launchHook`,
   * `rallyFactory` and `rallyRouter` are always the CURRENT generation and the only ones a
   * launch may use; trades and creator-fee reads resolve their generation per coin (see
   * `LaunchState.hook`).
   *
   * Absent or empty means the chain has never been redeployed. Both are equivalent and
   * neither is an error.
   */
  legacyDeployments?: LegacyDeployment[];
  /**
   * Every PROTOCOL v2 generation on this chain, newest first.
   *
   * v2 is a second launch layer, not a redeploy of this one. Hooks live in the PoolKey, so
   * v1 and v2 run side by side indefinitely and BOTH are current: a v1 coin keeps trading
   * on the v1 hook forever, and a new launch goes to whichever generation the caller
   * targets. It is kept apart from `legacyDeployments` because that list means "retired
   * but still serving its coins", and because the two protocols differ in what they emit
   * and how they price a curve trade.
   *
   * Absent means the chain has no v2 deployment, which is not an error.
   */
  v2Deployments?: V2Deployment[];
}

/**
 * One band of a v2 curve: a stretch of the launch's tick span, and the share of the
 * curve's tokens placed across it.
 *
 * `startBps`/`endBps` are basis points of the span from the launch price to the
 * graduation price, so a segment is positioned relatively and the same shape works for
 * any `B`. `sharesBps` across all segments must total 10000. `numPositions` is how many
 * ranges that band is split into, which is what makes a band a smooth ramp rather than a
 * step. `anchorAtFar` decides which edge of the band its positions bunch toward.
 */
export interface CurveSegment {
  startBps: number;
  endBps: number;
  numPositions: number;
  sharesBps: number;
  anchorAtFar: boolean;
}

/** The v2 shape surface for one generation, as `readCurveShapes` reports it. */
export interface CurveShapes {
  /** The `RallyCurveShapes` this describes. Per generation, not per chain. */
  address: Address;
  /** Whether a creator may launch on a bespoke shape rather than a preset. */
  customAllowed: boolean;
  maxSegments: number;
  /** Positions across a whole shape, not per segment. */
  maxPositionsTotal: number;
  presets: Array<{
    id: number;
    key: string;
    name: string;
    description: string;
    /** Undefined when governance has not configured that id. */
    segments?: CurveSegment[];
  }>;
}

/**
 * One PROTOCOL v2 generation. Role-named like `LegacyDeployment`, so a caller that only
 * needs an address can treat the two uniformly: `launchHook` is `RallyHookU4`,
 * `rallyFactory` is `RallyFactoryU4`.
 */
export interface V2Deployment {
  launchHook: Address;
  rallyFactory: Address;
  /** Pinned to one hook, so a v2 generation ships its own instance. */
  rallyRouter: Address;
  paramRegistry: Address;
  launchLib: Address;
  /**
   * `RallyCurveShapes`, the preset table a v2 launch's geometry is built from. No v1
   * equivalent. It is a constructor argument to both the hook and the factory, so it
   * belongs to the generation and not to the chain.
   */
  curveShapes?: Address;
  /**
   * `RallyLensU4`, the generation's read API. Every per-pool getter lives here rather than
   * on the hook, which keeps one state accessor and no convenience getters so it can fit
   * under EIP-170 permanently (its address encodes its permissions, so it can never be
   * replaced without abandoning every pool it hosts).
   *
   * Per generation, not per chain: a lens is constructed against one hook, so a coin is
   * read through the lens belonging to the hook it launched under.
   */
  lens?: Address;
  rallyVault?: Address;
  dividendDistributor?: Address;
  deploymentBlock: number;
}

/** One retired hook generation that still serves the coins launched under it. */
export interface LegacyDeployment {
  launchHook: Address;
  rallyFactory: Address;
  rallyRouter: Address;
  /**
   * That generation's own `RallyParamRegistry`. Every generation ships one, so a legacy
   * coin's curve and fee params come from HERE and governance on the current registry
   * never reaches it. Absent on entries written before the manifest carried it; the two
   * were the same contract then, so `generationsOf` reads the current one in its place.
   */
  paramRegistry?: Address;
  /**
   * That generation's CREATE2 token deployer, the mining `from` for its coins. Same
   * optionality and fallback as `paramRegistry`.
   */
  launchLib?: Address;
  /**
   * That generation's platform revenue vault. `treasury` is immutable on its hook and
   * factory, so this is where its fees land, permanently: a redeploy leaves it live and
   * still accruing rather than migrating it.
   */
  rallyVault?: Address;
  /**
   * That generation's §6.1 dividend distributor. Set per hook, so a coin launched under
   * this generation has its funded epochs recorded HERE and nowhere else.
   */
  dividendDistributor?: Address;
  /** That generation's gacha prize escrow, built against its vault and router. */
  gachaVault?: Address;
  /** Block that generation was deployed at, a `fromBlock` floor for scanning its logs. */
  deploymentBlock: number;
}

/**
 * A hook generation as the SDK probes it: the current one, or a legacy one. Returned by
 * `generationsOf`, current first then legacy newest first, with `paramRegistry` and
 * `launchLib` always filled (a legacy entry missing them reads the current ones).
 */
export interface HookGeneration {
  launchHook: Address;
  rallyRouter: Address;
  /**
   * Which PROTOCOL this generation runs: 1 for `RallyHook`, 2 for `RallyHookU4`.
   *
   * Not cosmetic. It decides how a curve trade is priced, which is the one thing a host
   * cannot get wrong quietly:
   *   - v1's curve is VIRTUAL. The pool holds no liquidity during CURVE, its price is
   *     pinned at the graduation price `P(B)`, and spot must be derived from the curve at
   *     the current `b` (`pricePerTokenWad`). Reading `poolPriceWad` overstates a curve
   *     coin by the whole remaining curve.
   *   - v2's curve IS the pool's liquidity. It quotes and prices like any v4 pool from
   *     block one, so `poolPriceWad` is spot in BOTH phases and the v1 derivation would be
   *     wrong instead.
   *
   * Read it off the generation a coin belongs to, never off the chain: both protocols are
   * live on a chain at once.
   */
  protocolVersion: 1 | 2;
  /** v2 only: the shape table this generation's launches are built from. */
  curveShapes?: Address;
  /** v2 only: `RallyLensU4`, where every per-pool read lives. Absent means this SDK
   *  version's manifest predates the lens, and v2 state cannot be read for it. */
  lens?: Address;
  /** Absent for a generation deployed before the creation path split out of the hook. */
  rallyFactory?: Address;
  /** The registry this generation's hook reads its params from. */
  paramRegistry: Address;
  /** The CREATE2 deployer of this generation's tokens. */
  launchLib: Address;
  /**
   * Where this generation's platform fees land, and where its dividend epochs and gacha
   * rounds live. Unlike `paramRegistry` and `launchLib` these are NOT filled in from the
   * current generation when a manifest does not record them: they rotate, so the current
   * ones are different contracts holding different money, and substituting them would
   * point a claim at a distributor that never funded the epoch. Undefined means "this SDK
   * version's bundled manifest does not record it". Upgrade the SDK rather than guess.
   */
  rallyVault?: Address;
  dividendDistributor?: Address;
  gachaVault?: Address;
  deploymentBlock: number;
}

/**
 * A coin's known generation, for hosts that already have it (from an indexer, say) and
 * want `getLaunch` to skip probing every generation. `hook` alone is enough when it is a
 * generation this SDK version knows: router, factory and registry fill in from it. Pass
 * `router` too when it is not, since the router is bound to one hook and cannot be
 * inferred from an unknown one; `paramRegistry` likewise, or the current one is assumed.
 */
export interface LaunchGeneration {
  hook?: Address;
  router?: Address;
  factory?: Address;
  paramRegistry?: Address;
}

/** Reads only — any viem client with a transport (`createPublicClient`, wagmi's). */
export type PublicClientLike = Client<Transport, Chain | undefined>;

/** Writes — a viem WalletClient, or anything exposing an account + transport. */
export type WalletClientLike = Client<Transport, Chain | undefined, Account | undefined>;

/**
 * An unsigned transaction. Every `prepare*` call returns these instead of sending, so
 * integrators on ethers, Privy, a Safe, or a backend signer can submit them with their
 * own stack — `to`/`data`/`value` is the whole contract.
 */
export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
}

/** Lifecycle phase of a launch (`RallyHook.phaseOf`). */
export type Phase = "NONE" | "CURVE" | "GRADUATED";

/** A governance-allowlisted quote asset and its per-quote launch economics. */
export interface QuoteConfig {
  address: Address;
  allowed: boolean;
  decimals: number;
  /** Graduation threshold `B`, in this quote's base units. */
  gradThreshold: bigint;
  /** Launch fee `F`, in this quote's base units. */
  launchFee: bigint;
  /** `10 ** (36 − decimals)` — normalises price WADs across 6dp/18dp quotes. */
  scale: bigint;
  /** True when this quote is the chain's wrapped native token. */
  isNative: boolean;
}

/**
 * The §6.1 fee split a creator picks: how the POST-platform remainder of every trading
 * fee is partitioned. Must sum to 10000. The platform's cut is taken off the top by
 * governance and is deliberately not expressible here.
 */
export interface FeeSplit {
  creatorBps: number;
  dividendBps: number;
  buybackBps: number;
  lpSupportBps: number;
}

/** Governance policy the fee split is validated against (RallyParamRegistry). */
export interface FeePolicy {
  /** Fixed platform cut off the top of every fee. */
  platformBps: number;
  /** Ceiling on `creatorBps` in the CURVE-ERA row. */
  creatorCapBps: number;
  /**
   * Ceiling on `creatorBps` in a v2 launch's POST-BREAKOUT row (§5.5), and deliberately
   * the wider of the two: a coin that reached `B` has already funded its own buyback and
   * LP-support war chest, so from breakout onward the creator may take more of the
   * remainder.
   *
   * `undefined` on a registry deployed before the key existed, which is every v1-only
   * chain. Treat that as "no second row here" rather than as zero, and let the chain do
   * the enforcing.
   */
  breakoutCreatorCapBps?: number;
  /** Bitmask: 1 = dividend, 2 = buyback, 4 = lp-support. */
  mechanismMask: number;
  dividendEnabled: boolean;
  buybackEnabled: boolean;
  lpSupportEnabled: boolean;
}

/** Registry values describing the bonding curve itself. */
export interface CurveParams {
  /** Total supply (18dp). */
  totalSupply: bigint;
  /** Tokens allocated to the curve (18dp). */
  curveAllocation: bigint;
  /** Anti-snipe fee at launch, bps. */
  feeStartBps: bigint;
  /** Floor the anti-snipe fee decays to, bps. */
  feeEndBps: bigint;
  /** Decay window, seconds. */
  feeDecaySeconds: bigint;
  /** Post-graduation CLMM fee, bps. */
  poolFeeBps: bigint;
}

/**
 * Creator-supplied display metadata pinned to `/<chainId>/<token>.json`.
 *
 * `name`, `symbol` and `imageUrl` are required: this is the blob every venue reads
 * to render a coin, and one without a name or a logo has no usable identity beyond
 * its address. Everything else is genuinely optional.
 *
 * This is the *write* contract. Read models stay nullable — the indexer resolves
 * arbitrary blobs (a third party can call the hook directly, without pinning here),
 * so on the read side any of these can be absent.
 */
export interface LaunchMetadata {
  name: string;
  symbol: string;
  /** Absolute https URL of an already-uploaded logo. */
  imageUrl: string;
  description?: string;
  /**
   * Absolute https URL of an already-uploaded wide banner (~3:1), shown behind the
   * coin's header. Optional — venues that don't render one can ignore it.
   */
  bannerUrl?: string;
  website?: string;
  /** Bare handle or full URL. */
  twitter?: string;
  telegram?: string;
}

/**
 * `LaunchMetadata` as handed to `prepareLaunch` / `launch`.
 *
 * `name` and `symbol` are already required at the top level of `LaunchParams` and
 * the SDK copies them into the pinned blob, so repeating them here is optional —
 * supply them only to pin something different from what the token is deployed with.
 */
export type LaunchMetadataParams = Omit<LaunchMetadata, "name" | "symbol"> &
  Partial<Pick<LaunchMetadata, "name" | "symbol">>;

/** Live on-chain state of one launch. */
export interface LaunchState {
  token: Address;
  pid: Hex;
  quote: QuoteConfig;
  phase: Phase;
  /** Bonded quote `b` — graduation progress is `bonded / gradThreshold`. */
  bonded: bigint;
  /** The launch's own `B`, read per-pool (not the registry default). */
  gradThreshold: bigint;
  /** Unix seconds the curve opened — the anti-snipe fee decays from here. */
  launchedAt: number;
  /** Unix seconds of graduation, or 0 while still on the curve. */
  graduatedAt: number;
  /** Quote per whole token, decimal-normalised WAD. Pinned at `P(B)` during CURVE. */
  poolPriceWad: bigint;
  /** Reserves backing the pool: quote base units, token base units (18dp). */
  reserves: { quote: bigint; token: bigint };
  feeSplit: FeeSplit;
  quoteIsCurrency0: boolean;
  poolKey: import("./pool").PoolKey;
  /**
   * The hook this coin's pool is bound to. Not necessarily the chain's current
   * `launchHook`: a coin launched before a redeploy stays on its original generation for
   * life, so every trade and creator-fee read for it targets THIS hook.
   */
  hook: Address;
  /** The router serving `hook`. Approvals and swaps for this coin target it. */
  router: Address;
  /**
   * The factory that launched this coin, when its generation has one. Absent for a
   * generation deployed before the creation path split out of the hook.
   */
  factory?: Address;
  /**
   * The `RallyParamRegistry` this coin's hook reads. Every generation has its own, so
   * curve and fee params for this coin (`readCurveParams`, `readFeePolicy`) must come from
   * here, not from the chain's current registry.
   */
  paramRegistry: Address;
  /** The CREATE2 deployer of this coin's generation, when known. */
  launchLib?: Address;
  /**
   * Which PROTOCOL this coin runs on: 1 for `RallyHook`, 2 for `RallyHookU4`. Permanent,
   * since a v4 hook is part of the PoolKey.
   *
   * Branch on this before reading `poolPriceWad` or quoting a curve trade. On v1 the field
   * is `P(B)` during CURVE and spot only after graduation, and a trade is priced against a
   * virtual constant-product reserve; on v2 it is spot in both phases and a trade is priced
   * by walking `ladder`. Using either protocol's rule on the other is wrong by the whole
   * remaining curve, not by a rounding error.
   */
  protocolVersion: 1 | 2;
  /** v2 only: the pool's live `sqrtPriceX96`, which `poolPriceWad` is derived from. */
  sqrtPriceX96?: bigint;
  /** v2 only: the pool's live tick. Graduation latches when it reaches `gradTickOf`. */
  tick?: number;
  /** v2 only: the curve SHAPE this launch was opened with (§4.2), frozen at creation. */
  curvePreset?: number;
  /**
   * v2 only: the launch's position ladder, which IS its bonding curve. Read once with the
   * rest of the state so a quote needs no further round trip. Ranges may NEST, so the
   * liquidity at a price is a sum across positions rather than one position's.
   */
  ladder?: LadderPosition[];
}

export type TradeSide = "buy" | "sell";

/** A priced trade, before any transaction is built. */
export interface TradeQuote {
  side: TradeSide;
  /** Input in the input leg's base units (quote for a buy, token 18dp for a sell). */
  amountIn: bigint;
  /** Estimated output in the output leg's base units. */
  amountOut: bigint;
  /** The `amountLimit` a swap built from this quote will submit. */
  minAmountOut: bigint;
  /** Tolerance applied to reach `minAmountOut`, bps. */
  slippageBps: bigint;
  /** Live anti-snipe curve fee on this trade, bps (0 once graduated). */
  feeBps: bigint;
  /** Curve fee charged, in quote base units. */
  feeQuote: bigint;
  /** Quote per whole token at the current state, decimal-normalised WAD. */
  priceWad: bigint;
  /** True when this buy would bond `b` to `B` and graduate the launch mid-swap. */
  crossesGraduation: boolean;
  /**
   * True when the estimate reproduces the on-chain math exactly (a non-crossing curve
   * trade). False for a graduation-crossing buy and for any graduated-pool estimate,
   * which model CLMM slippage only approximately — those get the wider slippage band.
   */
  exact: boolean;
  phase: Phase;
}

/**
 * A priced exact-OUTPUT trade: what a wanted output costs.
 *
 * The mirror image of {TradeQuote}'s bound. Exact-in bounds the output from below
 * (`minAmountOut`); exact-out bounds the INPUT from above, so `maxAmountIn` is
 * `amountIn` widened by the tolerance rather than cut by it.
 *
 * On the curve the estimate is the contract's own closed-form inverse; once graduated it
 * inverts the constant-product estimate over the locked position's real reserves, same
 * accuracy class as the graduated exact-in path — `exact` says which one you got.
 */
export interface TradeQuoteExactOut {
  /** Estimated input needed, in the input leg's base units. */
  amountIn: bigint;
  /** The `amountLimit` a swap built from this quote will submit: a ceiling on the input. */
  maxAmountIn: bigint;
  /** Fee charged (curve fee, or the hook's post-graduation fee), in quote base units. */
  feeQuote: bigint;
  /** True when this buy would bond `b` to `B` and graduate the launch mid-swap. */
  crossesGraduation: boolean;
  /** Tolerance applied to reach `maxAmountIn`, bps. */
  slippageBps: bigint;
  /**
   * True when the estimate reproduces the on-chain math exactly (a non-crossing curve
   * trade). False for a graduation-crossing buy and for any graduated-pool estimate,
   * which model CLMM slippage only approximately — those get the wider slippage band.
   */
  exact: boolean;
  phase: Phase;
}

/** Progress callbacks for the multi-step one-call helpers. */
export type LaunchStep =
  | "resolving"
  | "mining"
  | "pinning"
  | "approving"
  | "signing"
  | "confirming";

export type SwapStep = "quoting" | "approving" | "signing" | "confirming";

/**
 * How a third-party venue settles, which decides which router entrypoint fills it.
 *
 * `UNIV3`      the launch opens a Uniswap v3 fork pool and the coin is tradeable from its
 *              first block. One pinned pair token per venue.
 * `UNIV4`      a per-coin bonding curve that graduates into a hooked v4 pool. A coin here
 *              is on ONE of the two depending on whether it has graduated yet, so both
 *              paths have to be tried.
 * `DOPPLER_V4` opens a hooked v4 pool with real liquidity in the launch block and never
 *              migrates. No curve stage exists, so the v4 path is the only one.
 */
export type VenueDex = "UNIV3" | "UNIV4" | "DOPPLER_V4";

/** A third-party launchpad we list, as baked in from apps/indexer/src/externalVenues.json. */
export interface ExternalVenue {
  /** Stable tag, matching the indexer's `Venue` enum. */
  venue: string;
  dex: VenueDex;
  /** The launchpad's own factory. Identity, not a trade path. */
  factory: Address;
  /** UNIV3 only: the DEX factory its pools are deployed by, which `getPool` is called on. */
  dexFactory?: Address;
  /** UNIV3 only: the single quote every launch on this venue is paired against. */
  pairToken?: Address;
  pairDecimals?: number;
  /**
   * v4 venues only: the hook stamped on every pool the venue opens. A coin's pool id is
   * derived from it, so this is what makes a v4 venue discoverable without an indexer.
   */
  memeHook?: Address;
}
