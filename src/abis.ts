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
 * vanity constraint, and the salt/predict helpers.
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
  // is the CREATE2 `from` that off-chain vanity mining must use.
  "function launchLib() view returns (address)",
  "function tokenVanity() view returns (uint8 prefixLen, uint8 suffixLen, uint64 prefixBits, uint64 suffixBits)",
  "function matchesVanity(address a) view returns (bool)",
  // Per-quote config: the launch fee F and graduation threshold B in that quote's own
  // base units, plus its decimals. Governance-tunable — always read, never assume.
  "function quotes(address quote) view returns (bool allowed, uint8 decimals, uint256 gradThreshold, uint256 launchFee, uint256 scale)",
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
  "function creatorFees(bytes32 pid) view returns (uint256)",
  // Non-view on-chain (it collects through an `unlock`), declared view because the SDK
  // only ever eth_calls it. Never send it as a transaction — use `pokeFees` for that.
  "function previewCreatorFees(bytes32 pid) view returns (uint256)",
  "function claimCreatorFees(bytes32 pid) returns (uint256 amount)",
  "function pokeFees(bytes32 pid)",
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
 */
export const rallyRouterAbi = parseAbi([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData, bool unwrapOut, uint256 amountLimit, uint256 deadline) payable returns (int256 delta)",
  "function swapExactEthIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, bytes hookData, address v3Pool, uint256 minQuoteOut, uint256 amountLimit, uint256 deadline) payable returns (int256 delta)",
  "function manager() view returns (address)",
  "function weth() view returns (address)",
  "event RallySwap(bytes32 indexed id, address indexed trader, bool zeroForOne, int128 amount0, int128 amount1, uint160 sqrtPriceX96, int24 tick)",
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
export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

export const uniswapV3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
