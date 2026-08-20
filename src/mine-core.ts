/**
 * The pure-JavaScript CREATE2 vanity miner — the fallback behind {mineVanitySalt},
 * used wherever the WASM engine can't run (no `WebAssembly`, a CSP that blocks
 * compilation, an instantiation failure).
 *
 * Pure-local either way: fetch the token init-code hash and the vanity pattern once,
 * then grind salts with no RPC per attempt. The loop hashes into one preallocated
 * 85-byte buffer (`0xff ‖ deployer ‖ salt ‖ initCodeHash`, exactly one keccak block)
 * and tests the digest byte-wise, so an attempt costs a keccak and nothing else — no
 * hex strings, no allocations. At the default 4-nibble pattern (`0x1f60…`) that is
 * ~65k expected attempts: fast enough here, and ~2× faster again in WASM.
 *
 * Runs anywhere: no worker_threads, no DOM. Callers who want more throughput can
 * shard the space themselves — give each worker a distinct `startNonce` and a
 * `stride` equal to the worker count.
 */
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { RallyError } from "./errors";
import { compileVanity, packSalt, type Vanity } from "./salt";

/** Which grind implementation to use. */
export type MineEngine = "auto" | "wasm" | "js";

export interface MineOptions {
  /** CREATE2 deployer (`from`) — the LaunchLib address, NOT the factory. */
  deployer: Address;
  /** The launching account the salt (and so the address) is bound to. */
  creator: Address;
  initCodeHash: Hex;
  vanity: Vanity;
  /** First nonce to try. Shard workers by giving each a distinct start. */
  startNonce?: bigint;
  /** Nonce increment per attempt; set to the worker count to shard the space. */
  stride?: bigint;
  /** Attempts between event-loop yields; also the `onProgress` cadence. */
  batchSize?: number;
  /** Give up after this many attempts. */
  maxAttempts?: number;
  /** Set false to grind synchronously without yielding (backends only — it blocks). */
  yieldBetweenBatches?: boolean;
  /**
   * Which engine to grind with. `"auto"` (default) uses the embedded WASM miner and
   * falls back to the JS loop if it can't be instantiated; `"js"` forces the fallback;
   * `"wasm"` throws instead of falling back.
   */
  engine?: MineEngine;
  onProgress?: (attempts: number) => void;
  signal?: AbortSignal;
}

export interface MineResult {
  salt: Hex;
  address: Address;
  attempts: number;
}

/** Hex string → bytes, without viem's validation overhead in the hot path. */
export function hexToBytes(hex: string, expectedLength: number): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== expectedLength * 2) {
    throw new RallyError(
      "INVALID_SALT",
      `Expected ${expectedLength} bytes, got ${clean.length / 2}: ${hex}`,
    );
  }
  const out = new Uint8Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Grind creator-bound salts in pure JS until the token address matches `vanity`.
 *
 * Throws `MINING_FAILED` when aborted or when `maxAttempts` is exhausted, rather than
 * returning a salt that would revert `VanityMismatch` on-chain.
 */
export async function mineVanitySaltJs(opts: MineOptions): Promise<MineResult> {
  const { deployer, creator, initCodeHash, vanity } = opts;
  const stride = opts.stride ?? 1n;
  const batchSize = opts.batchSize ?? 20_000;
  const maxAttempts = opts.maxAttempts ?? 50_000_000;
  const shouldYield = opts.yieldBetweenBatches ?? true;
  const compiled = compileVanity(vanity);
  const start = opts.startNonce ?? 0n;

  // Nothing pinned → any salt works.
  if (compiled.empty) {
    const salt = packSalt(creator, start);
    return {
      salt,
      address: create2Address(deployer, salt, initCodeHash),
      attempts: 0,
    };
  }

  // preimage = 0xff ‖ deployer(20) ‖ salt(32) ‖ initCodeHash(32) = 85 bytes.
  // The salt's high 20 bytes are the creator and never change; only the 12-byte
  // nonce tail at [41,53) is rewritten per attempt.
  const buf = new Uint8Array(85);
  buf[0] = 0xff;
  buf.set(hexToBytes(deployer, 20), 1);
  buf.set(hexToBytes(creator, 20), 21);
  buf.set(hexToBytes(initCodeHash, 32), 53);
  const view = new DataView(buf.buffer);

  // Split the 96-bit nonce so the inner loop only touches Numbers: `hi` is the top
  // 48 bits (rewritten on overflow), `lo` the bottom 48, which fit exactly in a
  // double and cover 2.8e14 attempts before carrying.
  const LO_LIMIT = 2 ** 48;
  let hi = start >> 48n;
  let lo = Number(start & 0xffffffffffffn);
  const strideNum = Number(stride);
  if (!Number.isSafeInteger(strideNum) || strideNum <= 0) {
    throw new RallyError("INVALID_SALT", `stride must be a positive safe integer, got ${stride}`);
  }
  const writeHi = () => {
    const h = hi & 0xffffffffffffn;
    view.setUint16(41, Number((h >> 32n) & 0xffffn));
    view.setUint32(43, Number(h & 0xffffffffn));
  };
  writeHi();

  const { checks } = compiled;
  let attempts = 0;

  for (;;) {
    for (let i = 0; i < batchSize; i++) {
      view.setUint16(47, Math.floor(lo / 4294967296));
      view.setUint32(49, lo % 4294967296);

      const digest = keccak256(buf, "bytes");
      let hit = true;
      for (let c = 0; c < checks.length; c++) {
        const check = checks[c]!;
        // The address is the digest's low 20 bytes, i.e. offset 12.
        if ((digest[12 + check.index]! & check.mask) !== check.expected) {
          hit = false;
          break;
        }
      }
      if (hit) {
        const nonce = (hi << 48n) | BigInt(lo);
        const salt = packSalt(creator, nonce);
        return {
          salt,
          // EIP-55 checksummed, so an address from either engine compares equal to one
          // from viem or from `predictToken`.
          address: getAddress(`0x${bytesToHex(digest.subarray(12))}`),
          attempts: attempts + i + 1,
        };
      }

      lo += strideNum;
      if (lo >= LO_LIMIT) {
        hi += BigInt(Math.floor(lo / LO_LIMIT));
        lo %= LO_LIMIT;
        writeHi();
      }
    }

    attempts += batchSize;
    opts.onProgress?.(attempts);
    if (opts.signal?.aborted) {
      throw new RallyError("MINING_FAILED", "Vanity mining aborted.", { details: { attempts } });
    }
    if (attempts >= maxAttempts) {
      throw new RallyError(
        "MINING_FAILED",
        `No vanity salt found in ${attempts} attempts. Raise maxAttempts, or check the ` +
          `factory's tokenVanity() pattern is satisfiable.`,
        { details: { attempts, vanity } },
      );
    }
    // Yield so a UI thread stays live and a Node event loop keeps serving I/O.
    if (shouldYield) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

/** viem's `getCreate2Address`, inlined over the same 85-byte layout. */
export function create2Address(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  const buf = new Uint8Array(85);
  buf[0] = 0xff;
  buf.set(hexToBytes(deployer, 20), 1);
  buf.set(hexToBytes(salt, 32), 21);
  buf.set(hexToBytes(initCodeHash, 32), 53);
  const digest = keccak256(buf, "bytes");
  return getAddress(`0x${bytesToHex(digest.subarray(12))}`);
}
