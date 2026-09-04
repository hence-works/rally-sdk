/**
 * ABI fragments for every call the SDK makes. Hand-authored (not the full generated
 * ABIs) so the published bundle stays small, but every signature here is copied from
 * the deployed Solidity in `packages/cohort-protocol/src`.
 *
 * Creation lives on RallyFactory, per-pool state and events on RallyHook, trading on
 * RallyRouter — the three are separate contracts and the split matters: `launch` is
 * NOT on the hook, but `Launched` is still emitted BY the hook, so a pool's whole log
 * stream has one source address.
 */
import { parseAbi } from "viem";

/**
 * RallyFactory — the launch creation path: `launch`, the quote allowlist, the address
 * and the salt/predict helpers.
 *
 * `launch` has two overloads. The 7-arg form takes an explicit fee split; the 6-arg
 * form defers to the governance `DEFAULT_*_BPS` on-chain, which is how the SDK avoids
 * having to read four registry keys just to reproduce the default.
 *
 * Funding: for the wETH quote, attach `msg.value == launchFee + initialBuy` (wrapped
 * 1:1 by the factory). Every other quote — and a wETH launch paid in wETH the caller
 * already holds — requires approving `launchFee + initialBuy` to the FACTORY.
 */
export const rallyFactoryAbi = parseAbi([
  "function launch(string name, string symbol, string metadataURI, bytes32 salt, address quote, uint256 initialBuy, (uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps) cfg) payable returns (bytes32 pid, address token)",
  "function launch(string name, string symbol, string metadataURI, bytes32 salt, address quote, uint256 initialBuy) payable returns (bytes32 pid, address token)",
  // The salt is creator-bound: its high 20 bytes MUST equal the launching account, so
  // the token's CREATE2 address commits to whoever sends `launch` and a mempool watcher
  // cannot reuse public calldata to steal the pre-pinned address.
  "function predictToken(bytes32 salt, string name, string symbol) view returns (address)",
  "function packSalt(address creator, uint96 nonce) pure returns (bytes32)",
  "function saltCreator(bytes32 salt) pure returns (address)",
  "function tokenInitCodeHash(string name, string symbol) view returns (bytes32)",
  // The token is deployed via CREATE2 by this helper, so LaunchLib — not the factory —
  // is the CREATE2 `from` that off-chain salt mining must use.
  "function launchLib() view returns (address)",
  // Per-quote config: the launch fee F and graduation threshold B in that quote's own
  // base units, plus its decimals. Governance-tunable — always read, never assume.
  "function quotes(address quote) view returns (bool allowed, uint8 decimals, uint256 gradThreshold, uint256 launchFee, uint256 scale)",
  // `quotes` is a mapping and so tells you nothing you did not already know the key for.
  // This is the enumeration: every quote ever registered, in registration order.
  //
  // APPEND-ONLY, and it deliberately keeps quotes governance has since disabled — pools
  // launched while a quote was allowed keep trading on it. So filter on `quotes(q).allowed`
  // before offering one as a launch option; do NOT treat presence here as permission.
  "function allQuotes() view returns (address[])",
  "function quoteCount() view returns (uint256)",
  // NOTE: `maxFirstBuy(address)` is deliberately absent. The §4.1 first-buy cap is not on
  // any deployed factory yet, and the live Robinhood one has no such selector, so calling
  // it reverts with no data. Add the fragment back with the deployment that carries it.
  "function quoteList(uint256 index) view returns (address)",
  "event QuoteRegistered(address indexed quote)",
  "function hook() view returns (address)",
  "function weth() view returns (address)",
  "function registry() view returns (address)",
  // The creator's fee-exempt first buy, as a fill. The v4 `Swap` this buy also produces
  // reports NOTHING: a curve-phase fill is answered entirely by the hook's
  // `BeforeSwapDelta`, so v4 moves no liquidity and emits `Swap` with both legs zero.
  // Same sign convention and currency ordering as `RallySwap`.
  "event FirstBuy(bytes32 indexed pid, address indexed buyer, int128 amount0, int128 amount1, uint160 sqrtPriceX96, int24 tick)",
]);

/**
 * RallyHook — the curve, the §6.1 fee escrow, graduation, and every per-pool read.
 * Keyed by v4 `PoolId`, which the SDK derives locally from (quote, token, hook).
 */
export const rallyHookAbi = parseAbi([
  "function bonded(bytes32 pid) view returns (uint256)",
  "function gradThreshold(bytes32 pid) view returns (uint256)",
  // Phase enum: 0 = NONE, 1 = CURVE, 2 = GRADUATED.
  "function phaseOf(bytes32 pid) view returns (uint8)",
  "function launchedAt(bytes32 pid) view returns (uint40)",
  "function graduatedAt(bytes32 pid) view returns (uint40)",
  "function poolPriceWad(bytes32 pid) view returns (uint256)",
  "function quoteOf(bytes32 pid) view returns (address)",
  "function poolReserves(bytes32 pid) view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function feeConfigOf(bytes32 pid) view returns ((uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps))",
  "function gradLiquidity(bytes32 pid) view returns (uint128)",
  // Complete and current in both phases: every fee is split into this balance by the trade
  // that earned it, so there is nothing uncollected for it to omit.
  "function creatorFees(bytes32 pid) view returns (uint256)",
  // Identical to `creatorFees`, and genuinely `view` on-chain now. It used to be
  // state-mutating — it ran a poke first, because post-graduation fees were only realized
  // on collection — and this fragment deliberately mis-declared it as `view` so callers
  // would eth_call rather than send it. That workaround is no longer needed; prefer
  // `creatorFees` in new code.
  "function previewCreatorFees(bytes32 pid) view returns (uint256)",
  "function claimCreatorFees(bytes32 pid) returns (uint256 amount)",
  "function pokeFees(bytes32 pid)",
  // §6.2 referrals. Keyed by (referrer, quote) rather than by pool: a venue refers trades
  // across many launches and claims once per quote asset. The claim pays `msg.sender`,
  // so there is no recipient argument to get wrong.
  "function referralFeesOwed(address referrer, address quote) view returns (uint256)",
  "function claimReferralFees(address quote) returns (uint256 amount)",
  "function weth() view returns (address)",
  "event Launched(bytes32 indexed pid, address indexed token, address indexed creator, address quote, uint256 gradThreshold, string metadataURI)",
  "event FeeConfigSet(bytes32 indexed pid, uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps)",
  "event Bonded(bytes32 indexed pid, uint256 bonded)",
  "event Graduated(bytes32 indexed pid, uint40 at, uint256 lpSeed, uint256 burned)",
  // The fee-exempt creator first buy. It emits no v4 `Swap` (v4 skips a hook's own
  // `beforeSwap` on a self-call), so this is the only log for an `initialBuy` fill —
  // parse it to report what the creator actually received.
  "event CreatorFeesAccrued(bytes32 indexed pid, address indexed creator, uint256 amount)",
  "event CreatorFeesClaimed(bytes32 indexed pid, address indexed creator, uint256 amount)",
  // Referral revenue, at the moment it is earned. Carries the pool so a venue can break
  // its earnings down per coin, and the quote because the balance it feeds is per-quote.
  "event ReferralFeesAccrued(bytes32 indexed pid, address indexed referrer, address indexed quote, uint256 amount)",
  "event ReferralFeesClaimed(address indexed referrer, address indexed quote, uint256 amount)",
]);

/**
 * RallyRouter — the app swap entrypoint. Trades go through it so the indexer can
 * attribute the real trader (v4's own `Swap` records only the router as sender).
 *
 * `amountLimit` bounds the *unspecified* leg: minimum output on exact-input, maximum
 * input on exact-output. Note the asymmetry — `0` opts out for exact-in but forbids
 * every fill on exact-out, where the opt-out value is `type(uint256).max`.
 *
 * `swapExactEthIn` buys a launch quoted in something the trader doesn't hold (USDC, …)
 * with native ETH: the router wraps `msg.value`, sells it for the quote on a caller-
 * supplied Uniswap **v3** pool, then spends the whole proceeds on the curve.
 *
 * `hookData` is the §6.2 referral envelope: 32 bytes of `abi.encode(referrer)` to credit a
 * venue with a share of the platform's cut, or empty. Nothing else is accepted — the hook
 * reverts `BadHookData`. Build it with the `referrer` option on the prepare calls rather
 * than by hand.
 */
export const rallyRouterAbi = parseAbi([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData, bool unwrapOut, uint256 amountLimit, uint256 deadline) payable returns (int256 delta)",
  "function swapExactEthIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, bytes hookData, address v3Pool, uint256 minQuoteOut, uint256 amountLimit, uint256 deadline) payable returns (int256 delta)",
  "function manager() view returns (address)",
  "function weth() view returns (address)",
  // `referrer` is the venue this fill's hookData named (zero for none) — an attribution
  // copy of what the hook decoded, so a fill can be credited to a venue without joining
  // against `ReferralFeesAccrued`.
  "event RallySwap(bytes32 indexed id, address indexed trader, address indexed referrer, bool zeroForOne, int128 amount0, int128 amount1, uint160 sqrtPriceX96, int24 tick)",
]);

/** RallyParamRegistry — governance-tunable params behind a 48h timelock. */
export const rallyParamRegistryAbi = parseAbi([
  "function value(uint8 key) view returns (uint256)",
]);

/** RallyToken — the launch ERC-20 (always 18dp; `metadataURI` frozen at launch). */
export const rallyTokenAbi = parseAbi([
  "function metadataURI() view returns (string)",
  "function hook() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

/** The ERC-20 slice used for quote allowances and balances. */
export const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** The two reads the SDK uses to prove a v3 pool really is the wETH/quote pair. */
/**
 * The one v4 PoolManager event the SDK reads: the creator's first buy at launch is an
 * ordinary swap placed by the factory, so this is where its filled amounts live. (The hook
 * cannot place it itself — v4 skips a hook's own `beforeSwap` on a self-call — which is why
 * there is no bespoke launch event to read instead.)
 */
/**
 * RallyFactoryU4 (deployed as protocol v2) — the PROTOCOL v2 creation path, settled on
 * Uniswap v4.
 *
 * `launch` has TWO forms. The struct form takes full control of both fee rows and the
 * curve shape; the 6-arg form defers all of it to the factory's own defaults. Both are
 * `payable`, and for a wETH-quoted launch either funding path works: send
 * `msg.value == launchFee + initialBuy` and the factory wraps it once, or send nothing
 * and have the same total pulled from an ERC-20 approval to the FACTORY. Every other
 * quote is approval-only. The mining helpers and the quote allowlist are unchanged, and
 * `quotes(address)` is byte-identical to v1's, so a caller reading launch terms needs no
 * branch.
 */
export const rallyFactoryU4Abi = parseAbi([
  // One struct replaces the former 8-arg, 9-arg and `launchCustom` overloads. They were
  // collapsed because the generated decoder for a 10-parameter external function is more
  // than the legacy code generator can schedule, and the protocol now builds without
  // via-IR. Every member carries exactly the meaning it had as a parameter.
  //
  // Both fee rows are named together (§5.5): the split while the coin is on the curve,
  // then the split from breakout onward. They are validated against different creator
  // ceilings, `CREATOR_CAP_BPS` for the curve row and the wider `BREAKOUT_CREATOR_CAP_BPS`
  // for the other, which is the whole point of there being two. Pass the same value twice
  // for a launch whose routing should not change when it breaks out.
  //
  // `segments` is the former `launchCustom`: empty selects `curvePreset`, non-empty is a
  // shape of the creator's own (§4.5) and `curvePreset` is then IGNORED rather than
  // conflicting. A custom shape is gated by `RallyCurveShapes.customAllowed` and held to
  // the same guards a preset passes: the shape rules, the hook's allocation band, and its
  // opening-depth window.
  "function launch((string name, string symbol, string metadataURI, bytes32 salt, address quote, uint256 initialBuy, (uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps) feeConfig, (uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps) breakoutFeeConfig, uint8 curvePreset, (uint16 startBps, uint16 endBps, uint16 numPositions, uint16 sharesBps, bool anchorAtFar)[] segments) args) payable returns (bytes32 pid, address token)",
  "function launch(string name, string symbol, string metadataURI, bytes32 salt, address quote, uint256 initialBuy) payable returns (bytes32 pid, address token)",
  "function predictToken(bytes32 salt, string name, string symbol) view returns (address)",
  "function packSalt(address creator, uint96 nonce) pure returns (bytes32)",
  "function saltCreator(bytes32 salt) pure returns (address)",
  "function tokenInitCodeHash(string name, string symbol) view returns (bytes32)",
  "function launchLib() view returns (address)",
  "function quotes(address quote) view returns (bool allowed, uint8 decimals, uint256 gradThreshold, uint256 launchFee, uint256 scale)",
  "function allQuotes() view returns (address[])",
  "function quoteCount() view returns (uint256)",
  "function quoteList(uint256 index) view returns (address)",
  "function hook() view returns (address)",
  "function registry() view returns (address)",
  "function defaultFeeConfig() view returns (uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps)",
  // The other half of the default (§5.5). Creator-weighted where `defaultFeeConfig` is
  // buyback-weighted, and that contrast IS the policy: on the curve a coin is building the
  // war chest its own breakout spends, and past breakout that job is done.
  "function defaultBreakoutFeeConfig() view returns (uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps)",
  "event QuoteRegistered(address indexed quote)",
  // No `sqrtPriceX96`/`tick`: a v2 first buy fills against REAL liquidity, so the core
  // v4 `Swap` in the same transaction carries both.
  "event FirstBuy(bytes32 indexed pid, address indexed creator, int128 amount0, int128 amount1)",
]);

/**
 * RallyHookU4 — the PROTOCOL v2 per-pool reads.
 *
 * Deliberately NOT a superset of `rallyHookAbi`. Three v1 reads are gone and one is
 * renamed, and the reasons are the same reason v2 exists:
 *
 *   - `poolPriceWad` and `poolReserves` do not exist. A v2 pool holds real liquidity from
 *     block one, so its price and its reserves are ordinary v4 pool state — read them off
 *     the PoolManager (`readSlot0`), not off the hook. Not porting them is a size
 *     decision, not an oversight: the hook has ~1.3 KB of EIP-170 headroom left.
 *   - `bonded(pid)` became `bondedOf(pid)`, and it is DERIVED rather than accumulated:
 *     the quote the launch's position ladder holds at the current price. Same number,
 *     computed instead of stored, which is why v2 emits `Bonded` only once.
 *   - `launchedAt`/`graduatedAt` fold into `launchOf`, one call instead of two, and the
 *     second is now `brokeOutAt` — v2 breaks out, it does not graduate (§4.7).
 */
export const rallyHookU4Abi = parseAbi([
  // §6.2 referrals, and NOT the shape v1 uses. v1 pools a referrer's earnings per QUOTE
  // asset (`referralFeesOwed(referrer, quote)` / `claimReferralFees(quote)`); this
  // generation accrues them per POOL, so both the read and the claim are keyed by `pid`.
  // Calling the v1 pair against a u4 hook does not return zero, it reverts
  // `UnknownSelector` through the fee-facet fallback, because those selectors exist on
  // neither the hook nor the facet.
  "function referralOwed(bytes32 pid, address referrer) view returns (uint256)",
  "function claimReferralFees(bytes32 pid) returns (uint256 amount)",
  // The referrer's share OF THE PLATFORM'S CUT, in bps, not a share of the fee: the
  // amount credited is `fee * feeSchedule.platformBps / 10000 * referralBps / 10000`, so
  // quoting this figure on its own overstates what a referrer earns by whatever the
  // platform's cut is. Read `RallyLensU4.feeScheduleOf(pid).platformBps` for the other
  // half, and note that one is frozen per launch while this one is live and global.
  //
  // Held on the hook rather than read from `REGISTRY_KEYS.REFERRAL_FEE_BPS`: these
  // contracts hold no registry, the factory does. That key is the v1 path, and the two
  // can hold different values.
  "function referralBps() view returns (uint16)",
  // The hook keeps no convenience getters at all. A v4 hook's address encodes its
  // permissions, so it can never be replaced without abandoning every pool it hosts, which
  // means it has to fit under EIP-170 permanently: getters are the cheapest thing to give
  // up, since each drags an ABI encoder in to return data already exposed here. Everything
  // derivable lives on `rallyLensU4Abi` instead.
  //
  // Raw slots, not a typed getter. Returning a `Launch` across the ABI cost the hook 1,352
  // bytes of runtime — measured — for a read path, against a contract that can never be
  // redeployed. So the hook publishes storage and the typed shape is rebuilt off-chain;
  // `RallyLensU4` is that reconstruction, and is what a host should read. These are here
  // for the lens itself and for anyone reading a field the lens does not expose.
  "function extsload(bytes32 slot) view returns (bytes32)",
  "function extsload(bytes32 startSlot, uint256 n) view returns (bytes32[])",
  "function keyOf(bytes32 pid) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
  "function curveFeeBps(bytes32 pid) view returns (uint256)",
  "function manager() view returns (address)",
  "function shapes() view returns (address)",
  // The one-way latch (§4.7). Named `Breakout` rather than v1's `Graduated` because v2
  // moves no liquidity when it fires: the curve positions stay exactly where they are, and
  // what changes is the phase, the resting fee, and which sinks are open.
  "event Breakout(bytes32 indexed pid, uint40 at, uint256 tailSupply, uint256 burned)",
  // The post-breakout fee row is now the one being applied. Emitted by the first
  // `pokeFees` to COMPLETE at or after breakout, not by the latch — see
  // `activeFeeConfigOf` on the lens for why the switch lags by one collection.
  "event BreakoutSplitArmed(bytes32 indexed pid)",
  // Writes. There is deliberately no `creatorFees` READ here: v2 has no such getter, and
  // the claimable balance is `RallyLensU4.quoteFeesOf(pid).creator`. Note that
  // `claimCreatorFees` pokes first, so a claim can pay MORE than that balance reads right
  // now: fees sitting uncollected on the positions are realised by the poke.
  "function claimCreatorFees(bytes32 pid) returns (uint256)",
  "function pokeFees(bytes32 pid)",
]);

/**
 * RallyLensU4 — the v2 read API.
 *
 * Deployed alongside the hook and recorded per generation, because it is constructed
 * against one hook and a coin must be read through ITS generation's lens. It holds
 * nothing, has no privileges and is not trusted by the hook, so redeploying it costs a
 * config change and nothing else.
 *
 * Not an oracle. `spotPriceWad` and `bondedOf` read live `slot0`, which anyone can move
 * within a block: read them to display a coin, never to price a trade against.
 */
export const rallyLensU4Abi = parseAbi([
  "function phaseOf(bytes32 pid) view returns (uint8)",
  "function bondedOf(bytes32 pid) view returns (uint256)",
  "function gradThreshold(bytes32 pid) view returns (uint256)",
  "function launchOf(bytes32 pid) view returns (address token, address creator, address quote, uint40 launchedAt, uint40 brokeOutAt)",
  // The CURVE-ERA split. Not necessarily the one in force: see `activeFeeConfigOf`.
  "function feeConfigOf(bytes32 pid) view returns ((uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps))",
  // The split from breakout onward, frozen at creation alongside the first and validated
  // against the wider `BREAKOUT_CREATOR_CAP_BPS` (§5.5).
  "function breakoutFeeConfigOf(bytes32 pid) view returns ((uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps))",
  // The row the next `pokeFees` will actually apply, and whether the post-breakout row has
  // taken over yet. Read THIS for "what does this coin pay right now": the switch is NOT
  // `phase == BREAKOUT ? breakout : curve`. It lags the latch by one collection, because
  // the window straddling breakout holds fees from both eras and settles under the capped
  // curve row (§5.4). Showing the post-breakout split from the moment of breakout
  // misreports the largest window a launch ever collects.
  "function activeFeeConfigOf(bytes32 pid) view returns ((uint16 creatorBps, uint16 dividendBps, uint16 buybackBps, uint16 lpSupportBps) config, bool armed)",
  "function feeScheduleOf(bytes32 pid) view returns ((uint16 curveFeeStartBps, uint16 curveFeeEndBps, uint32 curveFeeDecay, uint16 poolFeeBps, uint16 platformBps, uint16 creatorCapBps, uint16 breakoutCreatorCapBps))",
  "function quoteFeesOf(bytes32 pid) view returns ((uint256 creator, uint256 platform, uint256 dividend, uint256 buyback, uint256 lpSupport))",
  "function referralPendingOf(bytes32 pid) view returns (uint256)",
  "function curvePresetOf(bytes32 pid) view returns (uint8)",
  "function curveSupplyOf(bytes32 pid) view returns (uint256)",
  // The tick breakout latches at. A v2 coin's progress is a PRICE question, so this is
  // what "how far to breakout" measures against alongside the ladder.
  "function breakoutTickOf(bytes32 pid) view returns (int24)",
  "function positionsOf(bytes32 pid) view returns ((int24 tickLower, int24 tickUpper, uint128 liquidity, bytes32 salt)[])",
  "function supportOf(bytes32 pid) view returns ((int24 tickLower, int24 tickUpper, uint128 liquidity, bytes32 salt))",
  // Derived, and new in the lens: progress, spot, the graduation price, and FDV. The SDK
  // computes the first three off the ladder itself (exactly, and with no round trip), so
  // these are for hosts that would rather ask the chain than carry the math.
  "function progressBps(bytes32 pid) view returns (uint256)",
  "function spotPriceWad(bytes32 pid) view returns (uint256)",
  "function gradPriceWad(bytes32 pid) view returns (uint256)",
  "function fdvWad(bytes32 pid, uint256 totalSupply) view returns (uint256)",
  "function flushReadiness(bytes32 pid) view returns (bool ready, int24 refTick, int24 tick, int24 drift)",
  "function hook() view returns (address)",
  "function manager() view returns (address)",
]);

/**
 * RallyCurveShapes — the v2 preset table and the rules a shape has to satisfy.
 *
 * Reads only. `validate` is `pure`, so a host can check a bespoke shape before it mines a
 * salt or pins any metadata, rather than discovering it at the launch transaction.
 */
export const rallyCurveShapesAbi = parseAbi([
  "function presetOf(uint8 id) view returns ((uint16 startBps, uint16 endBps, uint16 numPositions, uint16 sharesBps, bool anchorAtFar)[])",
  "function validate((uint16 startBps, uint16 endBps, uint16 numPositions, uint16 sharesBps, bool anchorAtFar)[] segments) pure returns (uint256 positions)",
  // Whether a creator may launch on a shape of their own at all. Governance can close
  // this without touching a live launch, so it is read rather than assumed.
  "function customAllowed() view returns (bool)",
  "function MAX_SEGMENTS() view returns (uint256)",
  // Positions across a WHOLE shape, not per segment: each one is a `modifyLiquidity` on
  // every fee collection and a candidate tick crossing on every swap.
  "function MAX_POSITIONS_TOTAL() view returns (uint256)",
  // The whole layout a launch WOULD get, before it exists. Pure geometry, so a host can
  // price a prospective first buy against the real ladder instead of against v1's
  // constant-product curve, which describes a different coin.
  "function buildCurve((uint8 curvePreset, (uint16 startBps, uint16 endBps, uint16 numPositions, uint16 sharesBps, bool anchorAtFar)[] segments, uint256 totalSupply, uint256 curveAllocBps, uint256 B, uint256 tailBps, int24 tickSpacing, bool tokenIsCurrency0) params) view returns ((int24 tickLower, int24 tickUpper, uint128 liquidity, bytes32 salt)[] positions, uint256 curveSupply, int24 tickLower, int24 tickUpper)",
]);

export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  // v4 exposes pool state through raw storage reads rather than getters; `StateLibrary`
  // is the slot arithmetic, done here in `poolStateSlot`. One call answers price, tick
  // and both fee fields for a pool, which is all a v2 quote needs.
  "function extsload(bytes32 slot) view returns (bytes32)",
]);

export const uniswapV3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
