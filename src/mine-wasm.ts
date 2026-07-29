/**
 * WASM-backed CREATE2 vanity miner — the default engine.
 *
 * The whole grind loop lives in WASM (`packages/vanity-miner`, Rust → wasm32, with a
 * fully-unrolled Keccak-f[1600]): the host writes the fixed preimage
 * (`0xff ‖ deployer ‖ salt ‖ initCodeHash`) and the nibble pattern once, then calls
 * `mine(start, stride, budget)` in chunks and only the winning salt crosses back.
 * Measured ~0.8M hashes/s per thread, roughly 2× the pure-JS loop.
 *
 * The module is base64-embedded (≈3.5 KB) rather than fetched, so it works under any
 * CSP, in a Worker, in Node, and in a bundler that can't emit asset URLs — an
 * integrator installs one package and gets the fast path with no build config.
 *
 * Two constraints follow from the WASM layout, and {mineVanitySaltWasm} refuses the
 * job (rather than silently mis-mining) when either is violated:
 *   - the counter occupies the salt's low 8 bytes, so nonces are 64-bit; and
 *   - the pattern is carried in `u64`s, so at most 16 nibbles per side.
 */
import type { Address, Hex } from "viem";
import { RallyError } from "./errors";
import {
  bytesToHex,
  create2Address,
  hexToBytes,
  type MineOptions,
  type MineResult,
} from "./mine-core";
import { packSalt } from "./salt";
import { VANITY_WASM_BASE64 } from "./vanity-wasm";

interface WasmExports {
  memory: WebAssembly.Memory;
  pre_ptr(): number;
  found_ptr(): number;
  set_match(pn: number, pv: bigint, sn: number, sv: bigint): void;
  mine(start: bigint, stride: bigint, budget: bigint): bigint;
}

const MAX_U64 = (1n << 64n) - 1n;

let cached: Promise<WasmExports> | null = null;

/** Decode the embedded module without assuming `atob` or Node's Buffer exists. */
function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const nodeBuffer = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(b64, "base64"));
  throw new RallyError("UNSUPPORTED", "No base64 decoder (atob / Buffer) in this runtime.");
}

/** Instantiate once per process; the result is a few KB and stateless between grinds. */
export function loadVanityWasm(): Promise<WasmExports> {
  if (cached) return cached;
  cached = (async () => {
    if (typeof WebAssembly === "undefined" || typeof WebAssembly.instantiate !== "function") {
      throw new RallyError("UNSUPPORTED", "WebAssembly is unavailable in this runtime.");
    }
    // Cast the source: TS picks the `Module` overload (which resolves to an Instance,
    // not `{ instance, module }`) when the argument's ArrayBuffer type is generic.
    const source = (await WebAssembly.instantiate(
      decodeBase64(VANITY_WASM_BASE64) as unknown as BufferSource,
      {},
    )) as WebAssembly.WebAssemblyInstantiatedSource;
    return source.instance.exports as unknown as WasmExports;
  })().catch((err) => {
    cached = null; // a transient failure shouldn't poison every later launch
    throw err;
  });
  return cached;
}

/** Whether the WASM engine can run here. Never throws. */
export async function isWasmMinerAvailable(): Promise<boolean> {
  try {
    await loadVanityWasm();
    return true;
  } catch {
    return false;
  }
}

/**
 * Grind creator-bound salts in WASM until the token address matches `vanity`.
 *
 * Throws on abort, on an exhausted budget, or when the pattern/nonce space doesn't fit
 * the WASM layout — never a salt that would revert `VanityMismatch` on-chain.
 */
export async function mineVanitySaltWasm(opts: MineOptions): Promise<MineResult> {
  const { deployer, creator, initCodeHash, vanity } = opts;

  if (vanity.prefixLen > 16 || vanity.suffixLen > 16) {
    throw new RallyError(
      "UNSUPPORTED",
      `The WASM miner carries the pattern in u64s, so it supports at most 16 nibbles per ` +
        `side (got prefix ${vanity.prefixLen}, suffix ${vanity.suffixLen}).`,
      { details: { vanity } },
    );
  }
  const startNonce = opts.startNonce ?? 0n;
  const stride = opts.stride ?? 1n;
  if (startNonce < 0n || startNonce > MAX_U64 || stride <= 0n || stride > MAX_U64) {
    throw new RallyError(
      "UNSUPPORTED",
      "The WASM miner counts in the salt's low 8 bytes, so startNonce and stride must fit in 64 bits.",
      { details: { startNonce, stride } },
    );
  }

  // Nothing pinned → any salt works; don't spin up the module.
  if (vanity.prefixLen === 0 && vanity.suffixLen === 0) {
    const salt = packSalt(creator, startNonce);
    return { salt, address: create2Address(deployer, salt, initCodeHash), attempts: 0 };
  }

  const wasm = await loadVanityWasm();
  const memory = new Uint8Array(wasm.memory.buffer);

  // Preimage: 0xff (1) ‖ deployer (20) ‖ salt (32) ‖ initCodeHash (32). The salt's
  // high 20 bytes are fixed to the creator (the front-run binding), and the module
  // grinds only its low 8 bytes at PRE[45..53] — leaving PRE[41..45] zero, exactly
  // the layout `packSalt` produces off-chain.
  const pre = wasm.pre_ptr();
  memory[pre] = 0xff;
  memory.set(hexToBytes(deployer, 20), pre + 1);
  memory.set(hexToBytes(creator, 20), pre + 21);
  memory.fill(0, pre + 41, pre + 45);
  memory.set(hexToBytes(initCodeHash, 32), pre + 53);

  wasm.set_match(vanity.prefixLen, vanity.prefixBits, vanity.suffixLen, vanity.suffixBits);

  // A chunk is one uninterruptible WASM call, so it also sets the abort/progress
  // granularity: ~5M hashes is a few seconds at worst and keeps a UI responsive.
  const chunk = BigInt(opts.batchSize ?? 5_000_000);
  const maxAttempts = BigInt(opts.maxAttempts ?? 50_000_000);
  const shouldYield = opts.yieldBetweenBatches ?? true;

  let nonce = startNonce;
  let attempts = 0n;
  while (attempts < maxAttempts) {
    const budget = maxAttempts - attempts < chunk ? maxAttempts - attempts : chunk;
    const found = wasm.mine(nonce, stride, budget);
    if (found >= 0n) {
      const foundPtr = wasm.found_ptr();
      const saltHex = `0x${bytesToHex(memory.slice(foundPtr, foundPtr + 32))}` as Hex;
      const tries = (BigInt(found) - startNonce) / stride + 1n;
      return {
        salt: saltHex,
        // Recompute rather than reading the address back out of WASM memory: the salt
        // is the only thing that has to be right, and this cross-checks it for free.
        address: create2Address(deployer, saltHex, initCodeHash),
        attempts: Number(tries),
      };
    }

    attempts += budget;
    nonce = (nonce + stride * budget) & MAX_U64;
    opts.onProgress?.(Number(attempts));
    if (opts.signal?.aborted) {
      throw new RallyError("MINING_FAILED", "Vanity mining aborted.", {
        details: { attempts: Number(attempts) },
      });
    }
    if (shouldYield) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  throw new RallyError(
    "MINING_FAILED",
    `No vanity salt found in ${attempts} attempts. Raise maxAttempts, or check the ` +
      `factory's tokenVanity() pattern is satisfiable.`,
    { details: { attempts: Number(attempts), vanity } },
  );
}
