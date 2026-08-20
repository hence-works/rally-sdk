# @rally-fun/sdk

Launch and trade [Rally](https://www.rallypad.fun) coins from your own app.

Rally is a memecoin launchpad built as a Uniswap v4 hook: a virtual bonding curve that
graduates atomically into a locked CLMM pool. This package is the headless client for
it — no React, no wallet UI, no backend of its own. It is what a terminal, aggregator,
bot, or chart site installs to let its own users create and trade coins in place.

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

// Launch a coin. Mines the vanity salt, pins nothing (you host the JSON), sends the tx.
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

- **The token address is mined, not assigned.** Rally's factory requires the launch
  token to land on a vanity pattern (`0x1f60…` by default), so the SDK grinds a CREATE2
  salt first. That salt is *creator-bound* — its high 20 bytes must equal the sending
  account — so the address commits to its creator and can't be front-run off public
  calldata.
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

### Vanity mining

Mining is pure-local — no RPC per attempt. The default engine is the embedded WASM
miner (Rust → wasm32, base64-inlined, ~3.5 KB, roughly 2× the JS loop); it falls back
to a pure-JavaScript loop wherever WASM can't run, such as a CSP that blocks
`WebAssembly.instantiate`. Both engines hash the same preimage and are pinned to
produce identical salts in the test suite.

```ts
import { mineVanitySalt, isWasmMinerAvailable } from "@rally-fun/sdk";

const { salt, address, attempts, engine } = await mineVanitySalt({
  deployer: rally.addresses.launchLib,   // the CREATE2 `from` — NOT the factory
  creator: myAddress,
  initCodeHash,
  vanity: await rally.getTokenVanity(),
  onProgress: (n) => setProgress(n),
  signal: controller.signal,
  // engine: "wasm" to fail loudly instead of falling back; "js" to force the fallback
});
```

The default 4-nibble pattern is ~65k expected attempts — around 400ms in WASM. Shard
across workers by giving each a distinct `startNonce` and a `stride` equal to the
worker count; pass a pre-mined `salt` to `prepareLaunch` to skip the grind.

---

## Trading

```ts
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
await rally.getTokenVanity();   // the current address pattern
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
address is the one failure an integrator cannot debug from their side. After changing
the Rust miner, run `packages/vanity-miner/build.sh`, which re-embeds the WASM into both
this package and the web app from the same build.
