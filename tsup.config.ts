import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points: the EVM client at `.` and the Solana client at `./solana`. They share
  // one error class (and so one `instanceof RallyError`) through a common chunk.
  entry: { index: "src/index.ts", solana: "src/solana/index.ts" },
  // Dual output: integrators are split between bundled ESM frontends (DexScreener,
  // GMGN-style terminals) and CommonJS Node backends (trading bots, keepers).
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  // CJS code splitting keeps `RallyError` a single class across both entry points; without
  // it each .cjs would embed its own copy and `isRallyError` would fail across them.
  splitting: true,
  sourcemap: true,
  target: "es2022",
  platform: "neutral",
  // viem and @solana/kit are peer deps so the host app's copy is the only one in the
  // bundle — two instances would mean two sets of ABI/type identities.
  external: ["viem", "@solana/kit"],
});
