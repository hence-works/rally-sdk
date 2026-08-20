import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // Dual output: integrators are split between bundled ESM frontends (DexScreener,
  // GMGN-style terminals) and CommonJS Node backends (trading bots, keepers).
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: "es2022",
  platform: "neutral",
  // viem is a peer dep so the host app's copy is the only one in the bundle —
  // two viem instances would mean two sets of ABI/type identities.
  external: ["viem"],
});
