/**
 * Engine selection for salt mining.
 *
 * Two engines grind the same two predicates (sort below the quote, and optionally end
 * in a hex suffix) and return interchangeable results: a fully-unrolled Keccak in WASM
 * (`./mine-wasm`, about 0.8M hashes/s per thread) and a pure-JS loop over viem's keccak
 * (`./mine-core`, about half that). The parity test pins them to the same answers.
 *
 * `auto`, the default, picks on the shape of the request rather than on availability:
 *
 *   - **no suffix: JS.** Ordering alone is a coin flip, so the grind ends in about two
 *     attempts and instantiating a WASM module to do it would cost more than it saves.
 *     This is also what keeps a plain launch on exactly the path it has always taken.
 *   - **a suffix: WASM, falling back to JS.** 16x per nibble is where the faster keccak
 *     starts to matter (a six-nibble suffix is 33.5M expected attempts), and a runtime
 *     with no WebAssembly still gets an answer, just slower.
 *
 * Pass `engine` to override, which is mostly for tests and for a host that has measured
 * its own runtime.
 */
import { mineSaltJs, type MineOptions, type MineResult } from "./mine-core";
import { isWasmMinerAvailable, mineSaltWasm } from "./mine-wasm";
import { parseSuffix } from "./suffix";

export type MineEngine = "auto" | "wasm" | "js";

export interface MineSaltOptions extends MineOptions {
  /** Which grind loop to use. Default `"auto"`; see the module note. */
  engine?: MineEngine;
}

/**
 * Grind a creator-bound salt whose token address sorts strictly below `quote` (I-7) and,
 * when asked for, ends in `suffix`.
 *
 * Throws `MINING_FAILED` on abort or an exhausted budget rather than returning a salt
 * that would revert `TokenMustSortBelowQuote` at `launch`, and `INVALID_SALT` for a
 * suffix that is not hex.
 */
export async function mineSalt(opts: MineSaltOptions): Promise<MineResult> {
  const engine = opts.engine ?? "auto";
  const suffix = parseSuffix(opts.suffix);

  if (engine === "js") return mineSaltJs(opts);
  if (engine === "wasm") return mineSaltWasm(opts);
  if (!suffix) return mineSaltJs(opts);

  // A suffix and no WASM is slow, not fatal. `isWasmMinerAvailable` never throws, so a
  // runtime without WebAssembly (or with it blocked) degrades instead of failing a
  // launch over a cosmetic option.
  return (await isWasmMinerAvailable()) ? mineSaltWasm(opts) : mineSaltJs(opts);
}

/**
 * Which engine `auto` would use for this request, without running it. Lets a UI say
 * what it is about to do (and warn about a slow grind) before the first hash.
 */
export async function selectMineEngine(opts: {
  suffix?: MineOptions["suffix"];
  engine?: MineEngine;
}): Promise<Exclude<MineEngine, "auto">> {
  const engine = opts.engine ?? "auto";
  if (engine !== "auto") return engine;
  if (!parseSuffix(opts.suffix)) return "js";
  return (await isWasmMinerAvailable()) ? "wasm" : "js";
}
