/**
 * WASM-backed CREATE2 salt miner: the default engine whenever a suffix is asked for.
 *
 * The whole grind loop lives in WASM (`packages/vanity-miner`, Rust to wasm32, with a
 * fully-unrolled Keccak-f[1600]): the host writes the fixed preimage
 * (`0xff ‖ deployer ‖ salt ‖ initCodeHash`), the suffix pattern and the quote bound
 * once, then calls `mine(start, stride, budget)` in chunks and only the winning salt
 * crosses back. Measured around 0.8M hashes/s per thread, roughly 2x the pure-JS loop,
 * which is the difference between a six-nibble suffix being a wait and being a walk
 * away.
 *
 * The module is base64-embedded (about 4 KB) rather than fetched, so it works under any
 * CSP, in a Worker, in Node, and in a bundler that cannot emit asset URLs: an integrator
 * installs one package and gets the fast path with no build config.
 *
 * Both predicates live inside the loop, the ordering one (I-7) included, so this engine
 * can never hand back a salt the JS engine would have rejected. Two constraints follow
 * from the WASM layout, and {@link mineSaltWasm} refuses the job rather than silently
 * mis-mining when either is violated:
 *   - the counter occupies the salt's low 8 bytes, so nonces are 64-bit; and
 *   - the suffix is carried in a `u64`, so at most 16 nibbles.
 */
import type { Address, Hex } from "viem";
import { RallyError } from "./errors";
import { MINE_WASM_BASE64 } from "./mine-wasm-bin";
import {
  bytesToHex,
  create2Address,
  hexToBytes,
  type MineOptions,
  type MineResult,
} from "./mine-core";
import { packSalt } from "./salt";
import { parseSuffix, suffixAttempts, suffixMaxAttempts, MAX_SUFFIX_NIBBLES } from "./suffix";

interface WasmExports {
  memory: WebAssembly.Memory;
  pre_ptr(): number;
  found_ptr(): number;
  set_suffix(sn: number, sv: bigint): void;
  set_quote(q0: bigint, q1: bigint, q2: bigint): void;
  mine(start: bigint, stride: bigint, budget: bigint): bigint;
  hash_addr(): void;
}

const MAX_U64 = (1n << 64n) - 1n;

/**
 * Attempts per uninterruptible `mine` call. This is the abort and progress granularity
 * as much as a batch size: a chunk cannot be cancelled from outside, so 2M (about 1.5s
 * on a slow thread) is what keeps a cancel button honest.
 */
const DEFAULT_CHUNK = 2_000_000;

let cached: Promise<WasmExports> | null = null;

/** Decode the embedded module without assuming `atob` or Node's Buffer exists. */
function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const nodeBuffer = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } })
    .Buffer;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(b64, "base64"));
  throw new RallyError("UNSUPPORTED", "No base64 decoder (atob / Buffer) in this runtime.");
}

/** Instantiate once per process; the result is a few KB and stateless between grinds. */
export function loadMinerWasm(): Promise<WasmExports> {
  if (cached) return cached;
  cached = (async () => {
    if (typeof WebAssembly === "undefined" || typeof WebAssembly.instantiate !== "function") {
      throw new RallyError("UNSUPPORTED", "WebAssembly is unavailable in this runtime.");
    }
    // Cast the source: TS picks the `Module` overload (which resolves to an Instance,
    // not `{ instance, module }`) when the argument's ArrayBuffer type is generic.
    const source = (await WebAssembly.instantiate(
      decodeBase64(MINE_WASM_BASE64) as unknown as BufferSource,
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
    await loadMinerWasm();
    return true;
  } catch {
    return false;
  }
}

/** Big-endian bytes `[from, to)` of an address, right-aligned in a u64. */
function addrWindow(bytes: Uint8Array, from: number, to: number): bigint {
  let v = 0n;
  for (let i = from; i < to; i++) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

/**
 * Grind creator-bound salts in WASM until the token address sorts below `quote` (I-7)
 * and ends in `suffix`, if one was asked for.
 *
 * Throws on abort, on an exhausted budget, or when the nonce space does not fit the
 * WASM layout. Never returns a salt that would revert at `launch`.
 */
export async function mineSaltWasm(opts: MineOptions): Promise<MineResult> {
  const { deployer, creator, initCodeHash, quote } = opts;
  const suffix = parseSuffix(opts.suffix);

  if (suffix && suffix.nibbles > MAX_SUFFIX_NIBBLES) {
    throw new RallyError(
      "UNSUPPORTED",
      `The WASM miner carries the suffix in a u64, so it supports at most ` +
        `${MAX_SUFFIX_NIBBLES} nibbles (got ${suffix.nibbles}).`,
      { details: { suffix: suffix.hex } },
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

  const wasm = await loadMinerWasm();
  const memory = new Uint8Array(wasm.memory.buffer);

  // Preimage: 0xff (1) ‖ deployer (20) ‖ salt (32) ‖ initCodeHash (32). The salt's
  // high 20 bytes are fixed to the creator (the front-run binding), and the module
  // grinds only its low 8 bytes at PRE[45..53], leaving PRE[41..45] zero, exactly
  // the layout `packSalt` produces off-chain.
  const pre = wasm.pre_ptr();
  memory[pre] = 0xff;
  memory.set(hexToBytes(deployer, 20), pre + 1);
  memory.set(hexToBytes(creator, 20), pre + 21);
  memory.fill(0, pre + 41, pre + 45);
  memory.set(hexToBytes(initCodeHash, 32), pre + 53);

  wasm.set_suffix(suffix?.nibbles ?? 0, suffix?.value ?? 0n);
  // The ordering bound is not optional in the module: an unset quote is all zeroes and
  // matches nothing, so this call is what makes the grind terminate at all.
  const quoteBytes = hexToBytes(quote, 20);
  wasm.set_quote(
    addrWindow(quoteBytes, 0, 8),
    addrWindow(quoteBytes, 8, 16),
    addrWindow(quoteBytes, 16, 20),
  );

  const chunk = BigInt(opts.batchSize ?? DEFAULT_CHUNK);
  const maxAttempts = BigInt(opts.maxAttempts ?? suffixMaxAttempts(suffix?.nibbles ?? 0));
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
      throw new RallyError("MINING_FAILED", "Salt mining aborted.", {
        details: { attempts: Number(attempts) },
      });
    }
    if (shouldYield) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  throw new RallyError(
    "MINING_FAILED",
    suffix
      ? `No salt found in ${attempts} attempts for an address ending in "${suffix.hex}" that ` +
        `also sorts below ${quote}. That is ${Math.round(
          Number(attempts) / suffixAttempts(suffix.nibbles),
        )}x the expected attempts; raise maxAttempts to keep going.`
      : `No salt found in ${attempts} attempts whose address sorts below ${quote}. About half ` +
        `of all salts should qualify, so this many misses means the quote address is ` +
        `pathologically low, not that you were unlucky.`,
    { details: { attempts: Number(attempts), quote, suffix: suffix?.hex } },
  );
}

/**
 * Hash an arbitrary 85-byte CREATE2 preimage through the module's own keccak and return
 * the resulting address. Exported for the parity test, which cross-checks it against
 * viem: a wrong rho or pi offset in the unrolled permutation shows up nowhere else.
 */
export async function wasmCreate2Address(
  deployer: Address,
  salt: Hex,
  initCodeHash: Hex,
): Promise<Address> {
  const wasm = await loadMinerWasm();
  const memory = new Uint8Array(wasm.memory.buffer);
  const pre = wasm.pre_ptr();
  memory[pre] = 0xff;
  memory.set(hexToBytes(deployer, 20), pre + 1);
  memory.set(hexToBytes(salt, 32), pre + 21);
  memory.set(hexToBytes(initCodeHash, 32), pre + 53);
  wasm.hash_addr();
  const found = wasm.found_ptr();
  return `0x${bytesToHex(memory.slice(found, found + 20))}` as Address;
}
