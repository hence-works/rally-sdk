# packages/sdk (@rally-fun/sdk)

The only **published** workspace. Headless TypeScript client third-party venues
(DexScreener-style terminals, bots, agents) install to launch and trade Rally coins in
their own UI. No React, no wallet UI, no backend.

Inherits the root [`CLAUDE.md`](../../CLAUDE.md). Treat everything exported from
`src/index.ts` as a **public API surface**: a rename is a breaking change for people
who cannot patch it.

## Rules

- **No runtime imports from private workspaces.** Addresses are baked in by
  `yarn workspace @rally-fun/sdk sync:deployments`, which regenerates
  `src/deployments.ts` from `packages/rally-protocol/deployments/*.json`. Re-run it after **every**
  redeploy and publish a new version: a stale bundled address is the one failure an
  integrator cannot debug from their side.
- **`viem` is a peer dependency.** Never promote it to a dependency; two viem copies
  mean two sets of ABI and type identities.
- **Every write has a `prepare*` form** returning an unsigned `{to, data, value}`
  alongside the viem one-call form, so integrators are not forced onto viem for
  signing. A new write without its `prepare*` twin is incomplete, and the API's MCP
  endpoint depends on that family existing.
- Clients built without a `walletClient` must throw `NO_WALLET` from the one-call
  helpers by construction. That is what makes the non-custodial MCP path structural.
- Errors are `RallyError` with a stable `RallyErrorCode`. Integrators branch on the
  code, so codes are additive only.
- **Quote is per launch.** Read the quote and its decimals from the launch. Never
  assume 18dp, never assume a single global quote. No float arithmetic on amounts.
- **During CURVE, `poolPriceWad` is the graduation price `P(B)`, not spot.** Spot is
  `pricePerTokenWad(curve, bonded, scaleFor(quoteDecimals))`, market cap is
  `fdv(curve, bonded)`. `quoteTrade` already does it right; anything new must match.
- Fees and thresholds come from `RallyParamRegistry`. `REGISTRY_KEYS` must move in
  lockstep with the Solidity `Key` enum (pinned by `test_keyOrdinalsAreStable`).
- Salt mining has **two engines behind one entry point**: `mineSalt` (`src/mine.ts`)
  picks the pure-JS loop (`src/mine-core.ts`, `mineSaltJs`) when no suffix is asked for
  and the embedded WASM keccak (`src/mine-wasm.ts`, built from `packages/vanity-miner`)
  when one is. Do not call an engine directly outside a test.
  - The protocol's own predicate is that the address must sort BELOW its quote (I-7), so
    the token is always `currency0`. `quote` is a REQUIRED option: the miner did not
    enforce ordering at all before, so a salt could be returned that reverts
    `TokenMustSortBelowQuote` at `launch`, after the metadata was pinned at it.
  - `suffix` is the ONLY vanity shape, and that is a protocol constraint. It pins the
    address's low nibbles, which is independent of the ordering bound, so the two
    compose at `2 · 16^n` expected attempts. A PREFIX pins the same high nibbles
    ordering governs and the two can be mutually unsatisfiable: the deleted prefix miner
    pinned `0x1f60…`, which does not sort below Robinhood's wETH at `0x0Bd7…`, so no
    wETH-quoted coin could be launched on that chain at all. Never add one back.
  - **`src/mine-wasm-bin.ts` is generated and committed.** Never hand-edit it;
    regenerate with `packages/vanity-miner/build.sh`, which is also the only consumer
    boundary that matters: one embedded copy, so a stale one cannot mine against the
    wrong keccak permutation while the other is right.
  - Both engines check ordering inside their loop, and `prepareLaunch` re-checks it for a
    caller-supplied salt (v2, where the rule exists). A host that grinds in a Worker
    skips both loops, so that check is the only thing left.
- The mining `from` is the CREATE2 deployer (`LaunchLib`), not the factory. `salt` is
  creator bound: the high 20 bytes must equal `msg.sender`.
- **The launch path mines from a RANDOM start (`randomNonce`), and must keep doing so.**
  `mineSalt` itself defaults `startNonce` to 0 and stays deterministic, which is what
  its parity tests and a sharded worker pool need. A launch cannot: the address is
  `CREATE2(LaunchLib, salt, initCodeHash(name, symbol))`, so the same creator
  relaunching the same name and ticker from 0 grinds the identical salt and reverts
  `TokenAddressTaken()` in `LaunchLib.mineAndDeploy` — after the metadata has been
  pinned at that address, which is not recoverable. A host that grinds its own salt
  owns this too.
- Every behavior change needs a test. `test/` covers curve math, launch, pool ids,
  salts and WASM/JS parity (`test/mine.test.ts`). That parity, plus the cross-check of
  the module's keccak against viem's `getCreate2Address` over 500 random preimages, is
  the guard against a wrong permutation shipping silently: a wrong rho or pi offset
  produces plausible addresses rather than an error, and the launch then reverts after
  the metadata has been pinned at one that will never exist.
- Keep `README.md` accurate: it is the docs an integrator reads before installing.
- No em dashes in code comments, README or commit messages.

## Commands

```sh
yarn workspace @rally-fun/sdk test
yarn workspace @rally-fun/sdk typecheck
yarn workspace @rally-fun/sdk build              # dual ESM + CJS + .d.ts (tsup)
yarn workspace @rally-fun/sdk sync:deployments   # re-bake addresses after a redeploy
```

## Release checklist

1. `sync:deployments` if any address moved. `prepublishOnly` runs
   `check:deployments`, which fails the publish when `src/deployments.ts` has drifted
   from `packages/rally-protocol/deployments/*.json`, so a stale address cannot ship silently.
2. `test` and `typecheck` green.
3. Bump the version (any exported-name change is breaking).
4. `npm publish` from this directory. `prepublishOnly` re-runs the check, build and
   tests. `files` ships `dist` and `README.md`; npm adds `LICENSE` and `package.json`.
   Publish a first release of any version line under `--tag next`, smoke test the
   tarball outside the monorepo, then promote with `npm dist-tag add`.
