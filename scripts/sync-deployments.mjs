#!/usr/bin/env node
/**
 * Regenerate `src/deployments.ts` from the deploy's own manifests
 * (`packages/cohort-protocol/deployments/<chainId>.json`), written by the forge scripts.
 *
 * The SDK is published to npm, so it cannot read a manifest at runtime: the addresses
 * have to be baked in. Run this after any redeploy, then bump the SDK version. A stale
 * bundled address is the one failure mode an integrator cannot debug from their side.
 *
 * Sourced from the submodule directly, rather than from the `packages/deployments` mirror
 * this used to read. That mirror was a copy of these same files kept in step by
 * `scripts/sync-envs.sh`, and a copy of a deploy record is exactly what goes stale when
 * someone redeploys and forgets to re-run the sync. One source, no sync step.
 *
 * A manifest with no `LaunchHook` is skipped: the forge script writes the file as soon as
 * it has anything to record, so a chain whose launch layer never landed still has one.
 *
 * Chain 31337 (local anvil) is skipped by default — that manifest is gitignored and
 * machine-specific. Pass `--include-local` for a dev build, or just hand the
 * addresses to `createRallyClient({ addresses })`.
 *
 * `--check` regenerates in memory and compares instead of writing, exiting non-zero when
 * `src/deployments.ts` has drifted from the manifests. `prepublishOnly` runs it, so a
 * publish carrying a stale address fails at pack time rather than reaching integrators.
 *
 *   node scripts/sync-deployments.mjs [--include-local] [--check]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The forge deploy's own output directory, which is the ONLY place a manifest is written.
// The former `packages/deployments` mirror was a copy of exactly these files, and a copy of
// a deploy record is the thing that silently goes stale when someone redeploys and forgets
// to re-run the sync.
const manifestDir = resolve(here, "../../cohort-protocol/deployments");
const out = resolve(here, "../src/deployments.ts");
const includeLocal = process.argv.includes("--include-local");
const checkOnly = process.argv.includes("--check");

const files = readdirSync(manifestDir)
  .filter((f) => /^\d+\.json$/.test(f))
  .filter((f) => includeLocal || f !== "31337.json")
  .sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));

const entries = files
  .map((f) => [Number(f.split(".")[0]), JSON.parse(readFileSync(join(manifestDir, f), "utf8"))])
  // A manifest with no `LaunchHook` is an aborted or chain-level-only deploy: the forge
  // script writes the file as soon as it has anything to record, so the directory can hold
  // a chain where the launch layer never landed. Baking one publishes a chain whose every
  // address is null, which an integrator can only discover by calling it.
  .filter(([id, m]) => {
    if (m.LaunchHook) return true;
    console.warn(`  skipping chain ${id}: manifest has no LaunchHook (deploy never completed)`);
    return false;
  });

const field = (v) => (v === undefined ? "undefined" : JSON.stringify(v));

// `LegacyDeployments`: every previous hook generation still live on the chain, newest
// first. Absent or empty on a chain that has never been redeployed; both mean the same
// thing, so the field is simply omitted then and `RallyAddresses.legacyDeployments`
// stays undefined.
//
// Each generation ships its own ParamRegistry and LaunchLib. Entries written before the
// manifest carried them have neither, and the SDK falls back to the top-level ones at
// runtime (`generationsOf`), so they are baked only when present rather than copied.
//
// RallyVault / DividendDistributor / GachaVault ride along for the same reason but with no
// fallback: they rotate with the generation and hold that generation's money, so the
// current ones are different contracts, not stale copies. Baked only when the manifest
// records them; otherwise the SDK reports undefined and the caller skips.
const legacy = (m) => {
  const list = Array.isArray(m.LegacyDeployments) ? m.LegacyDeployments : [];
  if (list.length === 0) return "";
  const rows = list
    .map((g) => {
      const parts = [
        `launchHook: ${field(g.LaunchHook)}`,
        `rallyFactory: ${field(g.RallyFactory)}`,
        `rallyRouter: ${field(g.RallyRouter)}`,
      ];
      if (g.ParamRegistry !== undefined) parts.push(`paramRegistry: ${field(g.ParamRegistry)}`);
      if (g.LaunchLib !== undefined) parts.push(`launchLib: ${field(g.LaunchLib)}`);
      if (g.RallyVault !== undefined) parts.push(`rallyVault: ${field(g.RallyVault)}`);
      if (g.DividendDistributor !== undefined) {
        parts.push(`dividendDistributor: ${field(g.DividendDistributor)}`);
      }
      if (g.GachaVault !== undefined) parts.push(`gachaVault: ${field(g.GachaVault)}`);
      if (g.CappedGovernor !== undefined) {
        parts.push(`cappedGovernor: ${field(g.CappedGovernor)}`);
      }
      parts.push(`deploymentBlock: ${g.DeploymentBlock ?? 0}`);
      return `      {\n${parts.map((p) => `        ${p},`).join("\n")}\n      },`;
    })
    .join("\n");
  return `\n    legacyDeployments: [\n${rows}\n    ],`;
};

// `V2Deployments`: every PROTOCOL v2 generation on the chain, newest first. Kept apart
// from `legacyDeployments` because v2 is a second launch layer rather than a retired
// version of this one: both are current, they run side by side forever, and they price a
// curve trade differently.
//
// Unlike a legacy entry, nothing here falls back to a top-level address. Those describe a
// v1 deployment, so reading a v2 coin's params off the top-level registry would answer
// with a different deployment's values instead of failing.
const v2 = (m) => {
  const list = Array.isArray(m.V2Deployments) ? m.V2Deployments : [];
  if (list.length === 0) return "";
  const rows = list
    .map((g) => {
      const parts = [
        `launchHook: ${field(g.LaunchHook)}`,
        `rallyFactory: ${field(g.RallyFactory)}`,
        `rallyRouter: ${field(g.RallyRouter)}`,
        `paramRegistry: ${field(g.ParamRegistry)}`,
        `launchLib: ${field(g.LaunchLib)}`,
      ];
      if (g.CurveShapes !== undefined) parts.push(`curveShapes: ${field(g.CurveShapes)}`);
      if (g.Lens !== undefined) parts.push(`lens: ${field(g.Lens)}`);
      if (g.RallyVault !== undefined) parts.push(`rallyVault: ${field(g.RallyVault)}`);
      if (g.DividendDistributor !== undefined) {
        parts.push(`dividendDistributor: ${field(g.DividendDistributor)}`);
      }
      if (g.CappedGovernor !== undefined) {
        parts.push(`cappedGovernor: ${field(g.CappedGovernor)}`);
      }
      parts.push(`deploymentBlock: ${g.DeploymentBlock ?? 0}`);
      return `      {\n${parts.map((p) => `        ${p},`).join("\n")}\n      },`;
    })
    .join("\n");
  return `\n    v2Deployments: [\n${rows}\n    ],`;
};

const body = entries
  .map(
    ([chainId, m]) => `  ${chainId}: {
    chainId: ${chainId},
    deploymentBlock: ${m.DeploymentBlock ?? 0},
    weth: ${field(m.WETH)},
    usdc: ${field(m.USDC)},
    poolManager: ${field(m.PoolManager)},
    paramRegistry: ${field(m.ParamRegistry)},
    launchLib: ${field(m.LaunchLib)},
    launchHook: ${field(m.LaunchHook)},
    rallyFactory: ${field(m.RallyFactory)},
    rallyRouter: ${field(m.RallyRouter)},
    dividendDistributor: ${field(m.DividendDistributor)},
    rallyVault: ${field(m.RallyVault)},
    gachaVault: ${field(m.GachaVault)},
    cappedGovernor: ${field(m.CappedGovernor)},
    rallyUniversalRouter: ${field(m.RallyUniversalRouter)},
    ponsV2CurveResolver: ${field(m.PonsV2CurveResolver)},${legacy(m)}${v2(m)}
  },`,
  )
  .join("\n");

const file = `// GENERATED by scripts/sync-deployments.mjs — do not edit by hand.
// Source: packages/cohort-protocol/deployments/<chainId>.json (written by a forge deploy).
// Regenerate after every redeploy, then publish a new SDK version.
import type { RallyAddresses } from "./types";

export const DEPLOYMENTS: Record<number, RallyAddresses> = {
${body}
};
`;

const chains = entries.map(([c]) => c).join(", ");

if (checkOnly) {
  const current = readFileSync(out, "utf8");
  if (current !== file) {
    console.error(
      `src/deployments.ts is stale: it does not match packages/cohort-protocol/deployments/*.json.\n` +
        `Run \`yarn workspace @rally-fun/sdk sync:deployments\`, review the diff, and bump the version.`,
    );
    process.exit(1);
  }
  console.log(`src/deployments.ts is current for chains: ${chains}`);
} else {
  writeFileSync(out, file);
  console.log(`Wrote ${out} for chains: ${chains}`);
}
