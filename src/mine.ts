/**
 * Vanity-salt mining: WASM by default, pure JS as the fallback.
 *
 * `mineVanitySalt` is what the launch flow calls. It tries the embedded WASM engine
 * first (~2× faster, and the module is base64-inlined so there is nothing to fetch or
 * configure), and drops to the JS loop when WASM can't run — an old runtime, a CSP
 * that forbids `WebAssembly.instantiate`, a pattern wider than the module's u64 layout.
 * The fallback is silent because both engines produce the same salts: they hash the
 * same 85-byte preimage and are cross-checked against viem's `getCreate2Address` in
 * the test suite. Only the throughput differs.
 *
 * Pass `engine: "js"` to force the fallback, or `engine: "wasm"` to fail loudly rather
 * than quietly grinding slower.
 */
import { RallyError } from "./errors";
import { mineVanitySaltJs, type MineEngine, type MineOptions, type MineResult } from "./mine-core";
import { mineVanitySaltWasm } from "./mine-wasm";

export {
  hexToBytes,
  bytesToHex,
  create2Address,
  mineVanitySaltJs,
  type MineEngine,
  type MineOptions,
  type MineResult,
} from "./mine-core";
export { isWasmMinerAvailable, loadVanityWasm, mineVanitySaltWasm } from "./mine-wasm";

/** Which engine a grind actually used — surfaced for diagnostics. */
export interface MineOutcome extends MineResult {
  engine: Exclude<MineEngine, "auto">;
}

/**
 * Grind a creator-bound CREATE2 salt until the launch token's address matches the
 * factory's vanity pattern.
 *
 * Throws `MINING_FAILED` on abort or an exhausted budget rather than returning a salt
 * that would revert `VanityMismatch` on-chain.
 */
export async function mineVanitySalt(opts: MineOptions): Promise<MineOutcome> {
  const engine = opts.engine ?? "auto";

  if (engine === "js") {
    return { ...(await mineVanitySaltJs(opts)), engine: "js" };
  }

  try {
    return { ...(await mineVanitySaltWasm(opts)), engine: "wasm" };
  } catch (err) {
    // An abort or an exhausted budget is the caller's answer, not an engine failure —
    // retrying in JS would ignore the cancellation and double the wait.
    const terminal = err instanceof RallyError && err.code === "MINING_FAILED";
    if (engine === "wasm" || terminal) throw err;
    return { ...(await mineVanitySaltJs(opts)), engine: "js" };
  }
}
