/**
 * The CREATE2 salt miner.
 *
 * A launch token's address is `CREATE2(LaunchLib, salt, initCodeHash)`, and the protocol
 * puts exactly one predicate on it: **the token must sort strictly below its quote** (I-7),
 * so the launch token is always `currency0` and the pool price is always quote-per-token.
 * A salt that misses it reverts `TokenMustSortBelowQuote` at `launch`.
 *
 * That is the whole search now. It used to also satisfy an address-VANITY pattern, and
 * removing it changed the shape of this file completely: a 4-nibble prefix cost ~65k
 * expected attempts and justified an embedded WASM engine beside this one, where ordering
 * against a normal quote address is a coin flip and lands in about two. The WASM miner and
 * the engine selection went with it.
 *
 * Worse than pointless, the two predicates could contradict each other. Both constrain the
 * HIGH nibbles of the address, so a pattern sorting above the quote made every launch on
 * that quote impossible — which is not hypothetical: `0x1f60…` against Robinhood's wETH at
 * `0x0Bd7…` meant no wETH-quoted v2 coin could ever be created there.
 *
 * Pure-local: fetch the init-code hash once, then grind with no RPC per attempt. The loop
 * hashes into one preallocated 85-byte buffer (`0xff ‖ deployer ‖ salt ‖ initCodeHash`,
 * exactly one keccak block) and compares the digest's low 20 bytes against the quote
 * byte-wise, so an attempt costs a keccak and nothing else.
 *
 * Runs anywhere: no worker_threads, no DOM.
 */
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { RallyError } from "./errors";
import { packSalt } from "./salt";

export interface MineOptions {
  /** CREATE2 deployer (`from`) — the LaunchLib address, NOT the factory. */
  deployer: Address;
  /** The launching account the salt (and so the address) is bound to. */
  creator: Address;
  initCodeHash: Hex;
  /**
   * The launch's quote. The mined address must sort strictly BELOW it (I-7).
   *
   * Required, deliberately. This predicate is the only thing standing between a caller and
   * a salt that reverts at `launch`, and it was previously absent here entirely — the miner
   * satisfied a vanity pattern and never checked ordering, so a launch succeeded or failed
   * on where the address happened to land. Making it optional would restore that.
   */
  quote: Address;
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
 * Grind creator-bound salts until the predicted token address sorts below `quote`.
 *
 * Throws `MINING_FAILED` when aborted or when `maxAttempts` is exhausted, rather than
 * returning a salt that would revert `TokenMustSortBelowQuote` on-chain.
 */
export async function mineSalt(opts: MineOptions): Promise<MineResult> {
  const { deployer, creator, initCodeHash, quote } = opts;
  const stride = opts.stride ?? 1n;
  const batchSize = opts.batchSize ?? 20_000;
  const maxAttempts = opts.maxAttempts ?? 1_000_000;
  const shouldYield = opts.yieldBetweenBatches ?? true;
  const start = opts.startNonce ?? 0n;

  // preimage = 0xff ‖ deployer(20) ‖ salt(32) ‖ initCodeHash(32) = 85 bytes.
  // The salt's high 20 bytes are the creator and never change; only the 12-byte
  // nonce tail at [41,53) is rewritten per attempt.
  const buf = new Uint8Array(85);
  buf[0] = 0xff;
  buf.set(hexToBytes(deployer, 20), 1);
  buf.set(hexToBytes(creator, 20), 21);
  buf.set(hexToBytes(initCodeHash, 32), 53);
  const view = new DataView(buf.buffer);

  // Compared byte-wise against the digest's low 20 bytes rather than as a BigInt: the
  // hot path should not allocate, and address ordering is plain big-endian byte order.
  const quoteBytes = hexToBytes(quote, 20);

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

  let attempts = 0;

  for (;;) {
    for (let i = 0; i < batchSize; i++) {
      view.setUint16(47, Math.floor(lo / 4294967296));
      view.setUint32(49, lo % 4294967296);

      const digest = keccak256(buf, "bytes");
      // The address is the digest's low 20 bytes, i.e. offset 12. Strictly below the
      // quote: equal is a revert too, and equality here would mean the launch token IS
      // the quote, which nothing downstream could make sense of.
      let hit = false;
      for (let b = 0; b < 20; b++) {
        const a = digest[12 + b]!;
        const q = quoteBytes[b]!;
        if (a !== q) {
          hit = a < q;
          break;
        }
      }
      if (hit) {
        const nonce = (hi << 48n) | BigInt(lo);
        return {
          salt: packSalt(creator, nonce),
          // EIP-55 checksummed, so an address from here compares equal to one from viem
          // or from `predictToken`.
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
      throw new RallyError("MINING_FAILED", "Salt mining aborted.", { details: { attempts } });
    }
    if (attempts >= maxAttempts) {
      throw new RallyError(
        "MINING_FAILED",
        `No salt found in ${attempts} attempts whose address sorts below ${quote}. About ` +
          `half of all salts should qualify, so this many misses means the quote address ` +
          `is pathologically low, not that you were unlucky.`,
        { details: { attempts, quote } },
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
