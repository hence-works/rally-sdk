# @rally-fun/sdk

Launch and trade [Rally](https://www.rallypad.fun) coins from your own app.

Rally is the programmable market layer for humans + agents, built as a Uniswap v4 hook:
every trade settles through the v4 PoolManager, and a coin graduates atomically into a
permanently locked full-range v4 position. This package is the headless client for it —
no React, no wallet UI, no backend of its own. It is what a terminal, aggregator, bot,
or chart site installs to let its own users create and trade coins in place.

```sh
npm install @rally-fun/sdk viem
```

`viem` is a peer dependency. Node ≥ 20; also runs in browsers, Workers, and edge
runtimes.

---

## Quick start

```ts
import { createPublicClient, createWalletClient, custom, http, parseEther } from "viem";
import { sepolia } from "viem/chains";
import { createRallyClient } from "@rally-fun/sdk";

const rally = createRallyClient({
  chainId: 11155111,
  publicClient: createPublicClient({ chain: sepolia, transport: http() }),
  walletClient: createWalletClient({ chain: sepolia, transport: custom(window.ethereum) }),
});

// Launch a coin. Mines the salt, pins nothing (you host the JSON), sends the tx.
const { token, pid } = await rally.launch({
  name: "Good Dog",
  symbol: "WOOF",
  quote: "WETH",
  initialBuy: parseEther("0.05"),
  metadataURI: "https://cdn.example.com/woof.json",
});

// Price a trade, then take it.
const quote = await rally.quote(token, { side: "buy", amountIn: parseEther("0.1") });
console.log(quote.amountOut, quote.feeBps, quote.minAmountOut);

await rally.swap(token, { side: "buy", amountIn: parseEther("0.1"), payWithEth: true });
```

## Two ways to sign

Every write has a `prepare*` form that returns an unsigned request and touches no
signer, so hosts that don't sign with viem — ethers, Privy, a Safe, a backend key —
keep their own submission path:

```ts
const prepared = await rally.prepareLaunch({ name, symbol, metadataURI });

prepared.token;    // the CREATE2 address the coin will land at, known before signing
prepared.pid;      // the v4 PoolId it will be keyed by, derived locally
prepared.totalCost;// launchFee + initialBuy, in the quote's base units
prepared.approval; // an ERC-20 approve, when the funding path needs one
prepared.request;  // { to, data, value, chainId } — send it however you like

await myEthersSigner.sendTransaction(prepared.request);
```

`prepareSwap`, `prepareSwapExactOut`, `prepareEthBuy` and `prepareLaunch` all work this
way. Reads never need a wallet at all.

---

## Launching

```ts
const result = await rally.launch({
  name: "Good Dog",
  symbol: "WOOF",
  quote: "WETH",              // or "USDC", or any allowlisted quote address
  initialBuy: parseEther("0.05"),   // optional fee-exempt creator first buy
  fees: {                     // optional §6.1 split; omit for governance defaults
    creatorBps: 5_000,
    dividendBps: 5_000,
    buybackBps: 0,
    lpSupportBps: 0,
  },
  metadataURI: "https://cdn.example.com/woof.json",
  onStep: (step) => console.log(step), // resolving → mining → approving → signing → confirming
});

result.token;           // the deployed ERC-20 (18dp, always)
result.pid;             // v4 PoolId
result.gradThreshold;   // B, in the quote's base units
result.firstBuyTokens;  // what `initialBuy` actually bought, if any
```

Four things worth knowing, because they constrain the order of operations:

- **The token address is mined, not assigned.** A launch token must sort BELOW its quote
  (so it is always `currency0`), so the SDK grinds a CREATE2 salt first. That salt is *creator-bound* — its high 20 bytes must equal the sending
  account — so the address commits to its creator and can't be front-run off public
  calldata. Pass `mining: { suffix: "cafe" }` to pin how the address ends; see
  [Salt mining](#salt-mining) for what each nibble costs.
- **Metadata comes after the address, never before.** The URI is frozen onto the token
  at launch and can never be changed, so it has to point at something that already
  resolves for an address that doesn't exist yet. That is why mining runs first.
- **The launch fee is per-quote and governance-tunable.** A wETH launch and a USDC
  launch cost different amounts in different decimals. The SDK reads `quotes(quote)`
  rather than assuming.
- **Fees are split, not owned.** `fees` partitions the *post-platform* remainder across
  creator / dividend / buyback / lp-support and must sum to 10000. The platform's cut
  is taken off the top by governance and deliberately isn't expressible here.

### Metadata

Bring your own URI (above), or let the SDK pin it. Pinning is wallet-authenticated
(SIWE → JWT), which costs the user one signature, cached for the session:

```ts
const rally = createRallyClient({
  chainId,
  publicClient,
  walletClient,
  metadata: { endpoint: "https://api.rallypad.fun/graphql" },
});

const imageUrl = await rally.uploadImage(file, file.type);
// Optional wide (~3:1) header image, rendered behind the coin's page header.
const bannerUrl = await rally.uploadImage(banner, banner.type);

await rally.launch({
  name: "Good Dog",
  symbol: "WOOF",
  metadata: {
    description: "he is a good dog",
    imageUrl,
    bannerUrl,
    twitter: "gooddog",
  },
});
```

A pinned blob needs `name`, `symbol` and `imageUrl` — `name` and `symbol` default to
the launch's own, so in practice only the logo has to be supplied. Everything else
(`description`, `bannerUrl`, socials) is optional.

Rally pins at `/<chainId>/<token>.json`. Already hold a session? Pass `metadata.token`
and no signature is requested. Want your own storage entirely? Pass an object
implementing `MetadataPinner` as `metadata`.

If you host the JSON yourself, `metadataURI` must be `https://`, `ipfs://`, or an
inline `data:application/json,...` document. The contract stores whatever string you
give it, forever, so `validateMetadataURI` refuses the forms that can never resolve
(`http://`, a bare `ipfs://` with no CID, a filename). Two consequences worth planning
around:

- **Rally's own surfaces do not fetch your URL.** They resolve a coin's name, logo and
  socials from Rally's pinning bucket, keyed by `(chainId, token)`, or by decoding an
  inline `data:` URI. An indexer dereferencing creator supplied hosts would be an SSRF
  rail, so it does not. Your venue renders your document fine; on Rally the coin shows
  as a bare address unless you pin through the service or inline the JSON.
- **Inline is the durable self hosted option.** `data:application/json,` plus the
  encoded document costs calldata once and can never 404:

  ```ts
  metadataURI: `data:application/json,${encodeURIComponent(JSON.stringify(doc))}`,
  ```

  It is also the only form whose document the SDK can see, so it is checked against
  the metadata schema before the grind starts. `name`, `symbol` and `imageUrl` are
  required; `description`, `bannerUrl`, `website`, `twitter` and `telegram` are
  optional; unknown keys are left alone. Logos take `https://` or `ipfs://` (a nested
  `data:` image is dropped by every read model, so it is refused), `website` must be an
  absolute http(s) URL, and socials take a bare handle or a full URL. `validateLaunchMetadataDocument`
  is exported if you want the same check over a document you host elsewhere.

### Salt mining

Mining is pure-local: no RPC per attempt. The only predicate the protocol puts on a launch
address is that it sorts below the launch's quote (I-7), which about half of all salts
satisfy, so a plain launch lands in a couple of attempts and `launch` mines it inline
without you noticing.

```ts
import { mineSalt } from "@rally-fun/sdk";

const { salt, address, attempts } = await mineSalt({
  deployer: rally.addresses.launchLib,   // the CREATE2 `from`, NOT the factory
  creator: myAddress,
  initCodeHash,
  quote: quoteAddress,                   // REQUIRED: the address must sort below it
  suffix: "cafe",                        // optional: pin the end of the address
  onProgress: (n) => setProgress(n),
  signal: controller.signal,
});
```

**`suffix` is the one vanity shape on offer**, and the ordering rule is why. A suffix pins
the address's low nibbles, which is independent of ordering, so the two predicates compose:
expected attempts are `2 · 16^n`. A prefix would pin the same high nibbles ordering
governs, and the two can be mutually unsatisfiable, which is not hypothetical: an earlier
version of this package mined a governed prefix pattern, and `0x1f60…` does not sort below
Robinhood's wETH at `0x0Bd7…`, so no wETH-quoted coin could be launched on that chain at
all. Hence suffix only.

| suffix | expected attempts | WASM, one thread |
| ------ | ----------------- | ---------------- |
| none   | 2                 | instant          |
| 4      | 131k              | under a second   |
| 6      | 33.5M             | tens of seconds  |
| 8      | 8.6B              | hours: don't     |

Two engines grind it. `mineSalt` picks with no configuration: the pure-JS loop when no
suffix is asked for (instantiating a module to do two hashes is not worth it), and an
embedded WASM keccak when one is, which measures 4x to 5x the JS loop and is base64 inlined
so it needs no bundler config and works under any CSP. Force one with
`engine: "wasm" | "js"`, and ask which one would run with `selectMineEngine`.

Both engines check ordering inside the loop, so neither can hand back a salt that reverts
`TokenMustSortBelowQuote`. `prepareLaunch` re-checks it for a salt you mined yourself,
because that revert lands *after* the metadata has been pinned at the address.

Shard across workers by giving each a distinct `startNonce` and a `stride` equal to the
worker count; pass a pre-mined `salt` to `prepareLaunch` to skip the grind, which is how a
UI keeps a long one off its main thread.
s
const launch = await rally.getLaunch(token);
// → phase, bonded/gradThreshold, poolPriceWad, reserves, feeSplit, poolKey, pid
```

`getLaunch` takes only a token address. It derives the candidate PoolId for each known
quote (and each hook generation, see below) locally and asks the hook which one exists,
so there is no indexer or API in the read path.

```ts
const q = await rally.quote(token, { side: "buy", amountIn: parseEther("0.1") });

q.amountOut;          // estimated tokens out (18dp)
q.minAmountOut;       // the bound the swap will submit
q.slippageBps;        // 100 when exact, 500 when approximate
q.feeBps;             // live anti-snipe fee — decays 25% → 1% over ~10 minutes
q.crossesGraduation;  // true when this buy graduates the launch mid-swap
q.exact;              // whether the estimate reproduces the on-chain math exactly
```

Two Rally-specific hazards drive that bound, and neither exists on a plain AMM: the
anti-snipe fee decays continuously, so a quote is only valid for the fee at execution
time; and a buy large enough to bond `b` to `B` graduates the launch *inside the swap*
and pays its remainder against a pool that didn't exist when you quoted. A non-crossing
curve trade is priced exactly and bounded at 1%; a crossing buy or a graduated pool is
an approximation and gets 5%. Override with `slippageBps` or `minAmountOut`.

On exact input, `0` is the router's **opt-out** from the bound, not a conservative
default: `_checkLimit` skips the comparison and the swap fills at whatever price it
lands on. So a trade that prices at zero output throws `INVALID_AMOUNT` rather than
building an unbounded market order. Pass `minAmountOut: 0n` if you really mean unbounded.

Every prepared swap carries a `deadline`, measured from **chain time** (the latest
block's timestamp), because that is what the router compares against. A browser clock
running behind would otherwise put the deadline in the past and revert `DeadlineExpired`
on every trade from that machine. Set the window with `deadlineSeconds` (default 600),
or pass an absolute `deadline` to bypass it. `chainDeadline(client, seconds)` is exported
for calldata you build yourself.

### Exact output

Works in both phases: on the curve it is the contract's closed-form inverse, priced
exactly; once graduated it inverts the reserve estimate above, comes back
`exact: false` and keeps the wider 5% default. It has both a quote and a prepared
transaction:

```ts
const q = await rally.quoteExactOut(token, {
  side: "buy",
  amountOut: 1_000_000n * 10n ** 18n,   // buy exactly 1M tokens
});

q.amountIn;      // estimated cost, in the input leg's base units
q.maxAmountIn;   // the ceiling the swap will submit as `amountLimit`
q.slippageBps;   // tolerance applied to reach it

await rally.swapExactOut(token, {
  side: "buy",
  amountOut: 1_000_000n * 10n ** 18n,
  // maxAmountIn: q.maxAmountIn,   // override the ceiling
  // payWithEth: true,             // wETH-quoted launches; the router refunds the rest
});
```

`prepareSwapExactOut(token, input)` is the unsigned form, returning
`{ quote, approval?, request, poolKey, zeroForOne, deadline }` like `prepareSwap`.

Three things flip versus exact input, and the SDK handles all three so hand-rolled
calldata does not have to:

- `amountSpecified` is **positive**. v4 reads the sign as the direction, so `+amountOut`
  is what makes the swap exact-output at all.
- **`amountLimit` reverses meaning**: minimum output on exact input, **maximum input** on
  exact output. The opt-out value reverses with it. Exact input opts out with `0`; exact
  output opts out with `type(uint256).max`. Passing `0` on an exact-output swap does not
  disable the check, it makes it unsatisfiable (every input exceeds 0) and the swap
  reverts `ExcessiveInput` every time. `prepareSwapExactOut` never emits `0`, and rejects
  a `maxAmountIn: 0n` override rather than building that transaction.
- The approval, and a `payWithEth` buy's `msg.value`, cover **`maxAmountIn`**, not the
  estimate. The router pulls what the swap actually costs up to the limit, so sizing
  either to `amountIn` fails exactly when the price moved in the direction the bound
  exists to tolerate. Over-sent ETH is refunded by the router.

An exact-output sell larger than the curve's bonded reserve is rejected locally with
`INVALID_AMOUNT`; on-chain that is `ExactOutputExceedsReserve`. A graduated launch throws
`UNSUPPORTED`: pricing it needs a v4 quoter.

### Paying with ETH

For a wETH-quoted launch, `payWithEth: true` sends native ETH — the router wraps it and
refunds the remainder, so no approval is needed. For a launch quoted in something the
trader doesn't hold (USDC, …), one call routes ETH → quote through a Uniswap v3 pool and
straight into the curve:

```ts
await rally.ethBuy(token, {
  amountIn: parseEther("0.25"),
  minAmountOut,          // required — the only bound across both legs
  // v3Pool: "0x…"       // defaults to the SDK's known wETH/quote route for the chain
});
```

The v3 pool is validated against `token0`/`token1` before the transaction is built, so
a wrong route fails locally instead of reverting `BadV3Pool` on-chain.

### Hook generations

Rally is a Uniswap v4 hook, and a hook address is part of every PoolKey. That means a
protocol redeploy cannot migrate existing pools: every coin launched under an earlier hook
stays bound to that hook, its factory and its router for life, and keeps trading there.
The SDK handles this for you:

- **Trades and creator-fee reads resolve per coin.** `getLaunch` probes every generation
  the bundled manifest knows (`generationsOf(addresses)`: current first, then legacy
  newest first) and records the one that owns the coin on the result as `launch.hook`,
  `launch.router` and `launch.factory`. `quote`, `swap`, `prepareSwap*` and
  `ethBuy` all read their targets from there, so a legacy coin's approval and swap go to
  the legacy router with a PoolKey embedding the legacy hook. Nothing to configure.
- **Curve and fee params come from the coin's own registry.** Every generation ships its
  own `RallyParamRegistry`, so governance can reprice one generation without touching
  another. `getLaunch` records it as `launch.paramRegistry`, every quote and swap reads
  its params from there, and `getCurveParams(registry?)` / `getFeePolicy(registry?)`
  default to the current registry (what a launch is priced against) but take a
  generation's registry to read what a legacy coin trades under. Caches are per registry.
- **Hosts with an indexer can skip the probe.** If you already know a coin's hook (the
  indexer's `Launch.hookAddress`), pass it and only that hook is probed:

  ```ts
  await rally.getLaunch(token, { hook });                    // known generation: router, registry fill in
  await rally.swap(token, { side: "buy", amountIn }, { hook });
  await rally.getLaunch(token, { hook, router, paramRegistry }); // a hook newer than this SDK
  ```

  A hook the SDK does not know needs its `router` alongside; the router is bound to a
  single hook, so it cannot be guessed. Pass its `paramRegistry` too (the indexer's
  `Launch.registryAddress`), or the current registry is assumed. Every trade method
  takes the same optional trailing `generation`.
- **Launching always uses the current generation.** `prepareLaunch`, `launch` and
  `predictToken` target the top-level `launchHook` / `rallyFactory` and nothing else.
- **Referral balances are per hook.** `referralFees(quote)` and `claimReferralFees(quote)`
  default to the current hook; pass a legacy hook as the last argument to read or claim
  what accrued from trades on coins bound to it.

A chain that has never been redeployed has no `legacyDeployments` on its address record,
and everything above degrades to a single generation. When Rally redeploys, a new SDK
version ships with the previous generation baked in; until you upgrade, the `{ hook,
router }` form keeps legacy coins tradeable.

### Referral fees

Every swap takes an optional `referrer`. Name your own payout address and you keep 20% ⚙
of the platform's cut of that trade's fee:

```ts
await rally.swap(token, {
  side: "buy",
  amountIn: parseEther("0.1"),
  referrer: "0xYourVenue…",   // your payout address
});

await rally.referralFees(quote);            // unclaimed, in that quote's base units
await rally.claimReferralFees(quote);       // pays your wallet; prepareClaimReferralFees for unsigned
```

**It costs the trader nothing.** The referral comes out of the protocol's own revenue, not
out of the fee the trader pays and not out of the creator's share, so a referred trade and
an unreferred one price identically. There is nothing to disclose to your users and nothing
that makes your venue worse to trade on than rallypad.fun.

There is no registration, no allowlist and no on-chain binding between a trader and a
venue: the referrer is named per swap and you may name a different one on the next call.
Balances are keyed by `(referrer, quote)`, not by pool, so refer trades across a hundred
launches and claim once per quote asset. Claims are pull-only and pay `msg.sender`, so
claim from the address you named. Balances live on the hook that processed the trade, so
after a redeploy a venue with fees on both generations claims once per hook (see
"Hook generations").

Under the hood this rides in the swap's `hookData` as 32 bytes of `abi.encode(referrer)`;
the hook rejects any other shape with `BadHookData`. Use the `referrer` option rather than
building it yourself, or `referralHookData(addr)` if you are assembling calldata by hand.
`RallyRouter` re-emits the referrer on `RallySwap`, so you can attribute your own fills
from logs without an indexer.

---

## Trading other launchpads' coins

Everything above is about coins launched on Rally. If you list an aggregated feed, the
other rows settle through a second contract, `RallyUniversalRouter`, under `rally.venue`.

The two routers are **not interchangeable in either direction.** `RallyRouter` fills only
Rally's coins; the universal router is refused them, because Rally's hook is deliberately
left off its venue allowlist. Route by which venue launched the coin.

```ts
const feeBps = await rally.venue.routeFeeBps();     // read it, do not hardcode

// Check the venue before your user signs, not as a revert.
const { routable, reasons } = await rally.venue.routable({ v3Factory });
if (!routable) return reasons;

// Quote the VENUE on what the venue actually receives.
const poolIn = netOfRouteFee(budget, feeBps);
const out = await yourQuoter(poolIn);

const tx = rally.venue.prepareSwapV3(pool, {
  token, buy: true, exactIn: true,
  amount: budget,                       // what the trader pays, fee included
  amountLimit: applySlippage(out, 100n), // FLOOR when exact-in
  deadline: await rally.chainDeadline(),
  value: budget,                        // native input: must EQUAL the budget
});
await rally.venue.send(tx);
```

Four entrypoints, one per settlement shape: `prepareSwapV3` (pass the **pool**, not a
path), `prepareSwapV2`, `prepareSwapCurve` (pass the venue's **resolver**, never a curve
address) and `prepareSwapV4`. Each has the unsigned form shown above; `rally.venue.send`
submits one if you would rather not. A fifth, `prepareSwapRoute`, fills a coin for a
trader who does not hold its quote at all (below).

**The route fee is a term of every quote.** Rally charges bps of the quote crossing the
trader's wallet and always takes it by subtraction: on a buy the venue is handed
`budget - fee`, so an exact-input buy costs exactly what the trader typed and the venue
fills a slightly smaller trade; on a sell the trader receives `payout - fee`. So quoting
the raw typed figure is wrong in both directions, and the floor you derive from it will
not fill. Convert with `netOfRouteFee` and `grossForNetRouteFee`. On an exact-**output**
sell the router's `amount` is what the venue must produce, so pass
`grossForNetRouteFee(wanted, feeBps)` to have the trader receive `wanted`.

**Approvals are one plain ERC-20 allowance** to the router, via
`rally.venue.prepareApproval(asset, amount)`. No Permit2 and no second leg. Size it to
what the router may *pull*, which on an exact-output trade is the ceiling, not the
estimate. A buy paying in native ETH approves nothing and attaches `value` instead, and
the router requires `msg.value` to **equal** the budget rather than merely cover it,
refunding whatever the fill leaves.

### Coins whose quote your user does not hold

A coin's quote is whatever its launcher picked, and on Robinhood that is routinely a
tokenized stock. The four entrypoints above can only fill such a coin for someone who
*already holds* that stock, so it ends up listed, priced and rendered for an audience that
cannot buy it. `prepareSwapRoute` is the other shape: **one conversion hop, then the
coin's own venue**, in one transaction and against one end-to-end bound.

```ts
import { routeLegV3, routeLegV4 } from "@rally-fun/sdk";

const tx = rally.venue.prepareSwapRoute({
  hop: routeLegV4(manager, wethStockKey), // wETH → the coin's quote. PINNED, see below.
  coin: routeLegV3(pool),                 // the coin's own venue, proved as ever
  token,
  buy: true,
  amountIn: budget,                       // exact input, route fee included
  minOut,                                 // end-to-end, AFTER the fee
  deadline: await rally.chainDeadline(),
  value: budget,                          // native input: must EQUAL amountIn
});
await rally.venue.send(tx);               // or rally.venue.swapRoute({…}) in one call
```

Build each leg with `routeLegV3` / `routeLegV2` / `routeLegV4` / `routeLegCurve`. One ABI
tuple covers all four shapes, so a leg carries a zeroed `manager` and `key` even where it
does not use them, and the helpers are what keep that from being a hand-encoding error.
`VENUE_KINDS` holds the ordinals, which are append-only. A curve is legal as the `coin`
leg only: it has no second quote to convert into, so naming one as the hop reverts.

Four things to get right:

- **Exact input only**, in both directions. There is no exact-output form.
- **`minOut` is end-to-end and post-fee**, in the asset your user actually receives. It is
  the only bound a route has; there is no per-leg one.
- **The fee is charged once, at the boundary, in the asset the trader routed in from**,
  never in the intermediate. A buy is skimmed before either venue sees it, so the trader
  spends exactly the figure they typed; a sell has it deducted from the output.
- **You do not name the intermediate**, or your user's own asset. The coin leg names the
  intermediate and the hop's far side falls out of the proved pool, so a route cannot
  claim a conversion it did not make.

**Do not discover the hop pool.** Robinhood carries dozens of empty `<stock>/<stable>` v4
pools per tokenized stock, one of them pricing SPCX at 3.4e50. Pick the hop from pinned or
depth-filtered data and keep `minOut` as the backstop, not as the filter.

A routed fill emits **two** events: `RallyRouted`, the fill priced in the coin's own quote
with its `fee` always zero, and `RallyRouteFilled` immediately after, the trade in the
assets that actually crossed the wallet. They answer different questions and only the
first is about the coin, so existing `RallyRouted` handling needs no change to count
routed fills correctly.

This SDK does **not** quote these venues. They are third-party contracts and their
pricing is theirs, so pricing them here would be a promise about somebody else's contract
that we could not keep across their next redeploy. Quote the venue yourself and convert.
A route means quoting both legs: the hop on `netOfRouteFee(amountIn, feeBps)`, then the
coin's venue on what the hop returns.

`rallyUniversalRouter` is absent on a chain with no external venues, which is the signal
that aggregated trading is off there rather than an error; the helpers throw
`MISSING_ADDRESS` rather than building calldata to nowhere.

---

## Chains & addresses

Addresses ship with the package, per chain, generated from the monorepo's deployment
manifests:

```ts
import { listSupportedChains, getBundledAddresses } from "@rally-fun/sdk";
```

Anything unbundled — a local anvil deploy, a chain newer than your installed version —
is an override away:

```ts
createRallyClient({ chainId: 31337, publicClient, addresses: { rallyFactory, launchHook, /* … */ } });
```

## Reading governance

Fees and thresholds are timelock-governable. Don't hardcode them; read them, and a
governance change re-flows on its own. The client caches these for 60s.

```ts
await rally.getCurveParams();   // supply, curve allocation, fee decay, pool fee
await rally.getFeePolicy();     // platform cut, creator cap, enabled mechanisms
await rally.listQuotes();       // allowlisted quotes with their fee + B + decimals
```

## Errors

Everything throws `RallyError` with a machine-readable `code` (`QUOTE_NOT_ALLOWED`,
`INVALID_FEE_SPLIT`, `MINING_FAILED`, `LAUNCH_REVERTED`, `NO_ETH_ROUTE`, …), so you can
branch without matching on message text. The original failure is preserved in `cause`.

```ts
import { isRallyError } from "@rally-fun/sdk";

try {
  await rally.launch({ /* … */ });
} catch (err) {
  if (isRallyError(err) && err.code === "INVALID_FEE_SPLIT") showFeeEditor();
  else throw err;
}
```

Note that a reverted transaction still produces a receipt — `waitForTransactionReceipt`
does not throw. The SDK checks `status` and raises `LAUNCH_REVERTED`, so a failed launch
never reads as a successful one.

## Money math

Every amount is a `bigint` in base units. Launch tokens are always 18dp; quotes are not
(USDC is 6dp), and price WADs are decimal-normalised through the launch's own `scale`.
Nothing here goes through a float, and neither should your integration.

---

## Development

```sh
yarn workspace @rally-fun/sdk build       # dual ESM + CJS + .d.ts via tsup
yarn workspace @rally-fun/sdk test        # vitest
yarn workspace @rally-fun/sdk typecheck
yarn workspace @rally-fun/sdk sync:deployments   # regenerate src/deployments.ts
```

After any redeploy, run `sync:deployments` and publish a new version — a stale bundled
address is the one failure an integrator cannot debug from their side.
