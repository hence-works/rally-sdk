/**
 * Trading a THIRD-PARTY launchpad's coin through Rally, via `RallyUniversalRouter`.
 *
 * The rest of this SDK is about Rally's own coins: `prepareSwap` and friends speak to
 * `RallyRouter`, price a Rally curve, and read a Rally launch. None of that applies to a
 * coin somebody else launched. This module is the other half, for a host that lists an
 * aggregated feed and wants one settlement path for every row in it.
 *
 * The two routers are NOT interchangeable in either direction. `RallyRouter` only fills
 * Rally's coins; the universal router is refused them, because Rally's hook is
 * deliberately left off its venue allowlist. Route by which venue launched the coin.
 *
 * ## The route fee is a term of every quote
 *
 * The router charges bps of the quote that crosses the trader's wallet, and it always
 * takes it by SUBTRACTION, on whichever side the quote is on:
 *
 *   buy   the venue is handed `budget - fee`, so an exact-input buy costs exactly the
 *         figure the trader typed and the venue fills a slightly smaller trade.
 *   sell  the trader receives `venuePayout - fee`.
 *
 * So a venue quote taken on the raw typed figure is wrong in both directions: it
 * overstates a buy's output (and the floor derived from it will not fill) and overstates
 * a sell's proceeds. {@link netOfRouteFee} and {@link grossForNetRouteFee} convert
 * between what the trader sees and what the venue sees. Read the rate with
 * {@link readRouteFeeBps} rather than hardcoding it: it is owner-settable, up to a
 * compile-time ceiling of 25 bps.
 *
 * ## What a caller still owns
 *
 * Quoting. The router does not quote, and this module deliberately does not either: the
 * venues are third-party contracts whose pricing is theirs, so a host quotes the venue
 * (a v3 quoter, a v4 quoter, the curve's own reserves) and converts with the two
 * helpers here. Pricing a foreign venue inside a published SDK would be a promise about
 * somebody else's contract that we cannot keep across their next redeploy.
 *
 * ## Coins the trader cannot hold the quote for
 *
 * The four direct entrypoints fill a coin only for someone who ALREADY HOLDS its quote,
 * and a coin's quote is whatever its launcher picked (on Robinhood, routinely a
 * tokenized stock). {@link prepareVenueSwapRoute} is the other shape: one conversion
 * hop, then the coin's own venue, in one transaction and against one end-to-end bound.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import { readContract } from "viem/actions";
import { rallyUniversalRouterAbi } from "./abis";
import { ZERO_ADDRESS } from "./addresses";
import { RallyError } from "./errors";
import type { PoolKey } from "./pool";
import type { PublicClientLike, RallyAddresses, TxRequest } from "./types";

const BPS = 10_000n;

/** Wide-open v4 price bounds, for a caller with no opinion beyond `amountLimit`. */
const MIN_SQRT_PRICE_LIMIT = 4295128739n + 1n;
const MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;

/** The router on `addresses`, or a typed failure naming the chain. */
function requireRouter(addresses: RallyAddresses): Address {
  const router = addresses.rallyUniversalRouter;
  if (!router || /^0x0+$/.test(router)) {
    throw new RallyError(
      "MISSING_ADDRESS",
      `No RallyUniversalRouter on chain ${addresses.chainId}, so third-party venue coins ` +
        "cannot be routed there. Rally's own coins trade through `rallyRouter` instead.",
      { details: { chainId: addresses.chainId } },
    );
  }
  return router;
}

function requirePositive(amount: bigint, field: string): void {
  if (amount <= 0n) {
    throw new RallyError("INVALID_AMOUNT", `\`${field}\` must be greater than zero.`, {
      details: { [field]: amount.toString() },
    });
  }
}

/**
 * The quote amount NET of the route fee: what the venue is handed on a buy, and what
 * the trader keeps on a sell.
 *
 * One function for both because the router takes the fee the same way on each side
 * (`_feeOf`, floored). `_settleTrade` charging `_feeUp(spent)` on a buy is not a second
 * convention, it is this operation's exact inverse, reconstructing the fee from the net
 * the router observed.
 *
 * Quote the venue on THIS, not on the trader's figure.
 */
export function netOfRouteFee(quoteAmount: bigint, routeFeeBps: number): bigint {
  if (routeFeeBps <= 0) return quoteAmount;
  return quoteAmount - (quoteAmount * BigInt(routeFeeBps)) / BPS;
}

/**
 * The inverse: the gross that leaves `net` once the fee is taken.
 *
 * Both exact-output shapes need it, in mirror image. On a buy the quoter solves what the
 * VENUE must receive and the ceiling the trader signs has to cover the fee as well. On a
 * sell the router's `amount` is the venue's OUTPUT and the fee is deducted after, so
 * asking for the typed figure delivers the typed figure minus the fee; asking for this
 * makes the receive leg mean what it says.
 *
 * Rounds up, so a ceiling is never a wei short and a sell never lands a wei under. The
 * router refunds a buy's unspent budget, so rounding up costs the trader nothing.
 */
export function grossForNetRouteFee(net: bigint, routeFeeBps: number): bigint {
  if (routeFeeBps <= 0) return net;
  const n = net * BPS;
  const d = BPS - BigInt(routeFeeBps);
  return n % d === 0n ? n / d : n / d + 1n;
}

/** The router's live route fee in bps. A term of every quote, so read it per session. */
export async function readRouteFeeBps(
  client: PublicClientLike,
  addresses: RallyAddresses,
): Promise<number> {
  const routeFeeBps = await readContract(client, {
    address: requireRouter(addresses),
    abi: rallyUniversalRouterAbi,
    functionName: "routeFeeBps",
  });
  return Number(routeFeeBps);
}

/** Whether the router is accepting trades at all. Paused is a live state, not an error. */
export async function readVenuePaused(
  client: PublicClientLike,
  addresses: RallyAddresses,
): Promise<boolean> {
  return readContract(client, {
    address: requireRouter(addresses),
    abi: rallyUniversalRouterAbi,
    functionName: "paused",
  });
}

/** One venue's place on the router's allowlist, as {@link readVenueRoutable} reports it. */
export interface VenueAllowlistQuery {
  /** A v3-fork pool's factory. */
  v3Factory?: Address;
  /** A v2-style pair's factory. */
  v2Factory?: Address;
  /** A v4 singleton. */
  poolManager?: Address;
  /** A v4 pool's hook. */
  venueHook?: Address;
  /** A curve venue's resolver. */
  venueResolver?: Address;
}

/**
 * Check a venue against the router's allowlist BEFORE a trader signs.
 *
 * The allowlist is a money control rather than configuration: a v4 pool must sit on an
 * allowlisted singleton AND carry an allowlisted hook, and a v3 pool's factory is
 * round-tripped through its own `getPool`, so a coin nobody listed is unroutable rather
 * than mis-routed. That is the right behaviour and a bad user experience to discover as
 * a revert, which is what this is for.
 *
 * Every field is optional and only the ones passed are read, so a caller checks exactly
 * the shape it is about to trade. An empty query is `true`: nothing was asked.
 */
export async function readVenueRoutable(
  client: PublicClientLike,
  addresses: RallyAddresses,
  query: VenueAllowlistQuery,
): Promise<{ routable: boolean; reasons: string[] }> {
  const router = requireRouter(addresses);
  const reasons: string[] = [];

  const checks: Array<[Address, "v3Factory" | "poolManager" | "venueHook" | "venueResolver", string]> =
    [];
  if (query.v3Factory) checks.push([query.v3Factory, "v3Factory", "v3 factory"]);
  if (query.poolManager) checks.push([query.poolManager, "poolManager", "pool manager"]);
  if (query.venueHook) checks.push([query.venueHook, "venueHook", "venue hook"]);
  if (query.venueResolver) checks.push([query.venueResolver, "venueResolver", "venue resolver"]);

  for (const [address, fn, label] of checks) {
    const ok = await readContract(client, {
      address: router,
      abi: rallyUniversalRouterAbi,
      functionName: fn,
      args: [address],
    });
    if (!ok) reasons.push(`${label} ${address} is not allowlisted`);
  }

  // The v2 allowlist answers a pair, not a bool, because a v2 fork's swap fee is not
  // discoverable from the pair and the router has to be told it.
  if (query.v2Factory) {
    const [allowed] = await readContract(client, {
      address: router,
      abi: rallyUniversalRouterAbi,
      functionName: "v2Factory",
      args: [query.v2Factory],
    });
    if (!allowed) reasons.push(`v2 factory ${query.v2Factory} is not allowlisted`);
  }

  return { routable: reasons.length === 0, reasons };
}

/**
 * Shared by every venue swap. `amount`/`amountLimit` are always in BASE UNITS.
 *
 * Deliberately no `buy` here: three of the four entrypoints take one and `swapV4` does
 * not, because it derives the direction from `zeroForOne` against the pool's own
 * currency order. Carrying a `buy` a caller could contradict would be a flag that means
 * nothing on one of the four.
 */
interface VenueSwapCommon {
  /** The launch token being bought or sold. */
  token: Address;
  /**
   * The bound the router enforces, and it reverses with the trade shape: a FLOOR on what
   * is received when exact-in, a CEILING on what is spent when exact-out. Stated in the
   * TRADER's terms, net of the route fee, which is what the router compares against.
   *
   * Never pass `0` on an exact-in trade meaning "no opinion": that is an unbounded
   * market order against a third-party venue.
   */
  amountLimit: bigint;
  /** Unwrap a wETH output back to native ETH. Harmless on a natively quoted venue. */
  unwrapOut?: boolean;
  /** Unix seconds. Compare against the CHAIN's clock, not the caller's. */
  deadline: bigint;
  /**
   * Native ETH to attach. The router requires this to EQUAL the budget it is about to
   * spend, not merely cover it, and refunds what the fill leaves. Omit for an ERC-20
   * input.
   */
  value?: bigint;
}

/** {@link prepareVenueSwapV3} / {@link prepareVenueSwapV2} parameters. */
export interface PrepareVenueSwapPoolParams extends VenueSwapCommon {
  /** True to spend the quote for the token, false to sell the token for the quote. */
  buy: boolean;
  /** True when `amount` is the input, false when it is the desired output. */
  exactIn: boolean;
  /** The exact leg: the input when `exactIn`, else the output the VENUE must produce. */
  amount: bigint;
}

/**
 * Trade a coin that settles in a v3-fork pool.
 *
 * `pool` is the pool itself, not a path: the router proves it came from an allowlisted
 * factory by round-tripping it through that factory's own `getPool`, which a contract
 * with a forged `factory()` getter cannot satisfy.
 *
 * On an exact-OUTPUT sell, `amount` is what the VENUE produces and the fee comes off
 * afterwards, so pass `grossForNetRouteFee(wanted, feeBps)` to have the trader receive
 * `wanted`.
 */
export function prepareVenueSwapV3(
  addresses: RallyAddresses,
  pool: Address,
  params: PrepareVenueSwapPoolParams,
): TxRequest {
  requirePositive(params.amount, "amount");
  const to = requireRouter(addresses);
  return {
    to,
    data: encodeFunctionData({
      abi: rallyUniversalRouterAbi,
      functionName: "swapV3",
      args: [
        pool,
        params.token,
        params.buy,
        params.exactIn,
        params.amount,
        params.amountLimit,
        params.unwrapOut ?? true,
        params.deadline,
      ],
    }),
    value: params.value ?? 0n,
    chainId: addresses.chainId,
  };
}

/**
 * Trade a coin that settles in a v2-style pair.
 *
 * The same shape as {@link prepareVenueSwapV3}, against a constant-product pair. The
 * router is told each v2 fork's swap fee when its factory is allowlisted, because a
 * pair does not expose one.
 */
export function prepareVenueSwapV2(
  addresses: RallyAddresses,
  pair: Address,
  params: PrepareVenueSwapPoolParams,
): TxRequest {
  requirePositive(params.amount, "amount");
  return {
    to: requireRouter(addresses),
    data: encodeFunctionData({
      abi: rallyUniversalRouterAbi,
      functionName: "swapV2",
      args: [
        pair,
        params.token,
        params.buy,
        params.exactIn,
        params.amount,
        params.amountLimit,
        params.unwrapOut ?? true,
        params.deadline,
      ],
    }),
    value: params.value ?? 0n,
    chainId: addresses.chainId,
  };
}

/** {@link prepareVenueSwapCurve} parameters. Exact-in only, on both sides. */
export interface PrepareVenueSwapCurveParams extends Omit<VenueSwapCommon, "amountLimit"> {
  /** True to spend the quote for the token, false to sell the token for the quote. */
  buy: boolean;
  /** The input: quote base units buying, token base units selling. */
  amountIn: bigint;
  /** Floor on what the trader receives, net of the route fee. */
  minOut: bigint;
}

/**
 * Trade a coin still on a third-party bonding curve.
 *
 * Takes the venue's RESOLVER, never a curve address, and that indirection is a money
 * control: the router's own event gates rewards, so a caller free to name an arbitrary
 * "curve" could mint routed volume out of a contract they wrote themselves. The resolver
 * returns the zero address for a coin it does not know, or knows but no longer fills
 * (one that has graduated onto a pool), and the router treats that as "not this venue's
 * coin" and reverts. A graduated coin trades through {@link prepareVenueSwapV4} or
 * {@link prepareVenueSwapV3} instead, depending on where the venue graduates to.
 *
 * Exact-output has no form here: a bonding curve is solved forward.
 */
export function prepareVenueSwapCurve(
  addresses: RallyAddresses,
  resolver: Address,
  params: PrepareVenueSwapCurveParams,
): TxRequest {
  requirePositive(params.amountIn, "amountIn");
  return {
    to: requireRouter(addresses),
    data: encodeFunctionData({
      abi: rallyUniversalRouterAbi,
      functionName: "swapCurve",
      args: [
        resolver,
        params.token,
        params.buy,
        params.amountIn,
        params.minOut,
        params.unwrapOut ?? true,
        params.deadline,
      ],
    }),
    value: params.value ?? 0n,
    chainId: addresses.chainId,
  };
}

/** {@link prepareVenueSwapV4} parameters. */
export interface PrepareVenueSwapV4Params extends VenueSwapCommon {
  /** The v4 singleton the pool lives on. Must be allowlisted, as must `key.hooks`. */
  manager: Address;
  /** The pool. `hooks` is the venue's own hook, not Rally's. */
  key: PoolKey;
  /** True to swap currency0 for currency1. */
  zeroForOne: boolean;
  /**
   * v4's own convention: NEGATIVE is exact-input, POSITIVE is exact-output. Deliberately
   * not re-spelled as a boolean plus a magnitude, so calldata a caller builds here reads
   * the same as the swap it becomes.
   *
   * On an exact-output SELL this is what the VENUE must produce; see
   * {@link grossForNetRouteFee}.
   */
  amountSpecified: bigint;
  /**
   * Passed straight through to the PoolManager, so it must be a real bound rather than
   * zero. Defaults to wide open in the direction of travel, which leaves the trader's
   * actual protection to `amountLimit`, where the router enforces it net of the fee.
   */
  sqrtPriceLimitX96?: bigint;
}

/**
 * Trade a coin in a hooked v4 pool.
 *
 * Both halves of the pool are checked: the singleton must be allowlisted AND the key's
 * hook must be. That is what stops a coin under an unlisted hook being filled, and it is
 * also why Rally's own coins cannot come through here.
 */
export function prepareVenueSwapV4(
  addresses: RallyAddresses,
  params: PrepareVenueSwapV4Params,
): TxRequest {
  if (params.amountSpecified === 0n) {
    throw new RallyError(
      "INVALID_AMOUNT",
      "`amountSpecified` must be non-zero: negative for exact-input, positive for exact-output.",
    );
  }
  return {
    to: requireRouter(addresses),
    data: encodeFunctionData({
      abi: rallyUniversalRouterAbi,
      functionName: "swapV4",
      args: [
        params.manager,
        params.key,
        params.token,
        {
          zeroForOne: params.zeroForOne,
          amountSpecified: params.amountSpecified,
          sqrtPriceLimitX96:
            params.sqrtPriceLimitX96 ??
            (params.zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT),
        },
        params.amountLimit,
        params.unwrapOut ?? true,
        params.deadline,
      ],
    }),
    value: params.value ?? 0n,
    chainId: addresses.chainId,
  };
}

// ──────────────── routed trades: a coin whose quote nobody holds ────────────────

/**
 * `RallyUniversalRouter.VenueKind` ordinals: which settlement shape fills one leg.
 *
 * APPEND-ONLY, for the same reason `REGISTRY_KEYS` is: the ordinal is what goes on the
 * wire, so inserting a member silently re-points every live route builder at a
 * different venue family. Never reorder, and never renumber.
 */
export const VENUE_KINDS = {
  /** A v2-style pair. The leg's `venue` is the pair. */
  V2: 0,
  /** A v3-fork pool. The leg's `venue` is the pool itself, never a path. */
  V3: 1,
  /** A v4 pool. The leg's `manager` and `key` describe it; `venue` is unused. */
  V4: 2,
  /**
   * A third-party bonding curve. The leg's `venue` is the allowlisted resolver, never a
   * curve address, and it is legal ONLY on the coin leg: a curve prices one coin against
   * one pair asset and has no second quote to convert into, so naming it as the hop
   * reverts `BadHopVenue`.
   */
  CURVE: 3,
} as const;

export type VenueKind = (typeof VENUE_KINDS)[keyof typeof VENUE_KINDS];

/**
 * One venue in a route, named the way that venue is proved (`RallyUniversalRouter.Leg`).
 *
 * One struct covers all four shapes, so the ABI tuple carries every field even where the
 * shape does not use it: a v3 leg still encodes a zeroed `manager` and `key`, and a
 * missing field is an encoding error rather than a default. Build one with
 * {@link routeLegV3}, {@link routeLegV2}, {@link routeLegV4} or {@link routeLegCurve}.
 */
export interface RouteLeg {
  kind: VenueKind;
  /** The v2 pair, the v3 pool, or a CURVE leg's resolver. Zero on a V4 leg. */
  venue: Address;
  /** V4 only: the singleton the pool lives on. Zero otherwise. */
  manager: Address;
  /** V4 only: the pool. Zeroed otherwise. */
  key: PoolKey;
}

/** The zeroed `PoolKey` a non-v4 leg still has to encode. Fresh per leg, never shared. */
function emptyKey(): PoolKey {
  return {
    currency0: ZERO_ADDRESS,
    currency1: ZERO_ADDRESS,
    fee: 0,
    tickSpacing: 0,
    hooks: ZERO_ADDRESS,
  };
}

/** A v3-fork leg. `pool` is the pool, proved through its own factory's `getPool`. */
export function routeLegV3(pool: Address): RouteLeg {
  return { kind: VENUE_KINDS.V3, venue: pool, manager: ZERO_ADDRESS, key: emptyKey() };
}

/** A v2-style leg. `pair` is the pair; the router knows each fork's fee from its factory. */
export function routeLegV2(pair: Address): RouteLeg {
  return { kind: VENUE_KINDS.V2, venue: pair, manager: ZERO_ADDRESS, key: emptyKey() };
}

/**
 * A v4 leg on `manager`, for pool `key`.
 *
 * The one asymmetry in a route: a v4 HOP may be hookless, a v4 COIN leg may not. The
 * venue-hook pin protects fill attribution, which a hop does not have, and every real
 * wETH/stock and stable/stock pool on Robinhood is hookless, so requiring a hook there
 * would have excluded every hop worth making.
 */
export function routeLegV4(manager: Address, key: PoolKey): RouteLeg {
  return { kind: VENUE_KINDS.V4, venue: ZERO_ADDRESS, manager, key };
}

/**
 * A third-party bonding-curve leg, by RESOLVER. Legal only as the `coin` leg.
 *
 * Same money control as {@link prepareVenueSwapCurve}: a caller free to name an
 * arbitrary "curve" could mint routed volume out of a contract they wrote themselves.
 */
export function routeLegCurve(resolver: Address): RouteLeg {
  return { kind: VENUE_KINDS.CURVE, venue: resolver, manager: ZERO_ADDRESS, key: emptyKey() };
}

/** {@link prepareVenueSwapRoute} parameters. Exact-in only, in both directions. */
export interface PrepareVenueSwapRouteParams extends Omit<VenueSwapCommon, "amountLimit"> {
  /**
   * The conversion leg. Its far side, whichever of its two assets is NOT the coin's
   * quote, is what the trader brings on a buy and takes away on a sell.
   *
   * DO NOT DISCOVER THIS POOL. Robinhood carries dozens of empty `<stock>/<stable>` v4
   * pools per tokenized stock, one of them pricing SPCX at 3.4e50, and picking a hop by
   * "a pool exists for this pair" walks a trade straight into one. The hop belongs to
   * pinned or depth-filtered data, with `minOut` as the backstop and not as the filter.
   */
  hop: RouteLeg;
  /** The coin's own venue, proved exactly as a direct fill proves it, hook pin included. */
  coin: RouteLeg;
  /** True to spend the routed-in asset on the coin, false to sell the coin back out to it. */
  buy: boolean;
  /** The exact input: the routed-in asset's base units on a buy, the coin's on a sell. */
  amountIn: bigint;
  /**
   * Floor on what reaches the trader, AFTER the route fee, end to end. The only bound a
   * route has: there is no per-leg one, deliberately, because a per-leg bound can be
   * satisfied twice and still deliver a bad fill.
   *
   * Never pass `0` meaning "no opinion": that is an unbounded market order across two
   * third-party venues.
   */
  minOut: bigint;
}

/**
 * Trade a coin through an intermediate the trader does not have to hold: one conversion
 * hop, then the coin's own venue, in one transaction.
 *
 * What a caller names is the hop pool, the coin's venue, the coin and the direction, and
 * that is all. **Neither the intermediate nor the trader's own asset is named**: the coin
 * leg names the intermediate (the coin's quote) and the hop's far side falls out of the
 * proved pool, so a route cannot claim to have converted something it did not. It follows
 * that both legs must actually meet, and a hop whose far side IS the coin reverts
 * `RouteIsCircular`.
 *
 * **Exact input only, both directions.** There is no exact-output form and there will not
 * be one: sizing a hop from the coin leg's realised input needs nested venue callbacks.
 * The single-hop entrypoints keep their exact-output mode.
 *
 * **The route fee is charged once, at the boundary, in the asset the trader ROUTED IN
 * FROM**, never in the intermediate. On a buy it is skimmed off the input before either
 * venue sees it, so the trader spends exactly the figure they typed; on a sell it is
 * deducted from the output. So `netOfRouteFee(amountIn, feeBps)` is what the hop is
 * handed on a buy, and a sell's proceeds are net of the fee on the far side.
 *
 * **`minOut` is end-to-end and post-fee**, in the asset the trader receives: the coin on a
 * buy, the routed-in asset on a sell.
 *
 * ETH follows the direct paths: attach `value` EQUAL to `amountIn` when the routed-in
 * asset is native or wETH, and `unwrapOut` (default true) delivers a wETH output leg as
 * native ETH. Everything else needs one plain ERC-20 approval to the router, sized to
 * `amountIn`, via {@link venueApprovalFor}.
 */
export function prepareVenueSwapRoute(
  addresses: RallyAddresses,
  params: PrepareVenueSwapRouteParams,
): TxRequest {
  requirePositive(params.amountIn, "amountIn");
  if (params.hop.kind === VENUE_KINDS.CURVE) {
    throw new RallyError(
      "VENUE_NOT_ROUTABLE",
      "A bonding curve cannot be a route's conversion hop: it prices one coin against one " +
        "pair asset and has no second quote to convert into. The router reverts " +
        "`BadHopVenue`. A curve is legal as the `coin` leg only.",
      { details: { hop: params.hop.venue } },
    );
  }
  return {
    to: requireRouter(addresses),
    data: encodeFunctionData({
      abi: rallyUniversalRouterAbi,
      functionName: "swapRoute",
      args: [
        {
          hop: params.hop,
          coin: params.coin,
          token: params.token,
          buy: params.buy,
          amountIn: params.amountIn,
          minOut: params.minOut,
          unwrapOut: params.unwrapOut ?? true,
          deadline: params.deadline,
        },
      ],
    }),
    value: params.value ?? 0n,
    chainId: addresses.chainId,
  };
}

/**
 * The ERC-20 approval a venue trade needs, or `null` when it needs none.
 *
 * One plain allowance to the router, and there is no second leg: this path uses no
 * Permit2. A buy paying in native ETH approves nothing and attaches `value` instead.
 *
 * `amount` must cover what the router may PULL, which on an exact-output trade is the
 * ceiling rather than the estimate.
 */
export function venueApprovalFor(
  addresses: RallyAddresses,
  asset: Address | null,
  amount: bigint,
): TxRequest | null {
  if (!asset || /^0x0+$/.test(asset)) return null;
  const router = requireRouter(addresses);
  return {
    to: asset,
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ] as const,
      functionName: "approve",
      args: [router, amount],
    }),
    value: 0n,
    chainId: addresses.chainId,
  };
}

/** Decoded `RallyRouted`, the fill as the router books it. */
export interface VenueFill {
  trader: Address;
  token: Address;
  /** The pool, pair or singleton that filled it. */
  venue: Address;
  /** The v4 pool id, or 32 zero bytes on a non-v4 route. */
  poolId: Hex;
  quote: Address;
  buy: boolean;
  /** Quote that crossed the wallet: INCLUDING the fee on a buy, EXCLUDING it on a sell. */
  quoteAmount: bigint;
  tokenAmount: bigint;
  /** Rally's cut, in the quote's base units. Carried, not inferable from the amounts. */
  fee: bigint;
}

/**
 * Decoded `RallyRouteFilled`: the trader-facing half of a {@link prepareVenueSwapRoute}
 * fill, emitted immediately after that fill's `RallyRouted` and never on a direct swap.
 *
 * The pair answers two different questions and only one of them is about the coin. The
 * `RallyRouted` beside this one is the FILL, priced in the intermediate that actually
 * crossed the coin's venue with its `fee` always zero, and it needs no special handling:
 * a reader that only knows about direct swaps already prices a routed fill correctly.
 * This is the TRADE. Keep them apart, or a coin's volume starts depending on which asset
 * each trader happened to arrive in, which is a property of the trader and not the coin.
 */
export interface VenueRouteFill {
  trader: Address;
  /** The coin, which is what joins this to the `RallyRouted` beside it. */
  token: Address;
  /** What left the trader's wallet. Zero is native ETH, **a buy funded with `value`
   *  included**: the router wraps on the trader's behalf, so wETH there is the venue's
   *  asset and never theirs. Fold ETH and wETH together yourself if you want one bucket;
   *  they are reported apart because they are different balances leaving the wallet. */
  assetIn: Address;
  /** What reached it. Zero is native ETH, an unwrapped wETH leg included. */
  assetOut: Address;
  /** What filled the conversion leg: the pair, the pool, or the v4 singleton. */
  hopVenue: Address;
  /** Trader perspective, route fee INCLUDED on a buy. */
  amountIn: bigint;
  /** Trader perspective, route fee ALREADY DEDUCTED on a sell. */
  amountOut: bigint;
  /** Rally's cut, in units of the asset the trader routed in from. Never the coin, never
   *  the intermediate. */
  routeFee: bigint;
}
