# @rally-fun/sdk

Launch and trade [Rally](https://rally.fun) coins from your own app.

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

`prepareSwap`, `prepareEthBuy` and `prepareLaunch` all work this way. Reads never need
a wallet at all.

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
  token to land on a vanity pattern (`0xba5e…` by default), so the SDK grinds a CREATE2
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
  metadata: { endpoint: "https://api.rally.fun/graphql" },
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

Rally pins at `/<chainId>/<token>.json`. If you host it yourself, any URL works — the
contract only stores the string. Already hold a session? Pass `metadata.token` and no
signature is requested. Want your own storage entirely? Pass an object implementing
`MetadataPinner` as `metadata`.

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
quote locally and asks the hook which one exists, so there is no indexer or API in the
read path.

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

Exact-output works on the curve too:

```ts
const { amountIn, maxAmountIn } = await rally.quoteExactOut(token, {
  side: "buy",
  amountOut: 1_000_000n * 10n ** 18n,   // buy exactly 1M tokens
});
```

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
