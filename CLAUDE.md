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
  `src/deployments.ts` from `packages/deployments/*.json`. Re-run it after **every**
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
- Vanity mining defaults to the WASM engine (`src/vanity-wasm.ts`, base64 embedded
  from `packages/vanity-miner`) with a pure-JS fallback. Both engines are pinned to
  identical output by the test suite. `src/vanity-wasm.ts` is generated: never edit it
  by hand, regenerate with `packages/vanity-miner/build.sh`, which re-embeds the web
  and SDK copies from one build.
- The vanity `from` is the CREATE2 deployer (`LaunchLib`), not the factory. `salt` is
  creator bound: the high 20 bytes must equal `msg.sender`.
- Every behavior change needs a test. `test/` covers curve math, launch, pool ids,
  salts and WASM/JS parity, and that parity is the guard against a wrong keccak
  permutation shipping silently.
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
   from `packages/deployments/*.json`, so a stale address cannot ship silently.
2. `test` and `typecheck` green.
3. Bump the version (any exported-name change is breaking).
4. `npm publish` from this directory. `prepublishOnly` re-runs the check, build and
   tests. `files` ships `dist` and `README.md`; npm adds `LICENSE` and `package.json`.
   Publish a first release of any version line under `--tag next`, smoke test the
   tarball outside the monorepo, then promote with `npm dist-tag add`.
