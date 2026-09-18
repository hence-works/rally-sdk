/**
 * The pure-JS CREATE2 salt miner, and the shared byte helpers both engines use.
 *
 * A launch token's address is `CREATE2(LaunchLib, salt, initCodeHash)`, and the protocol
 * puts exactly one predicate on it: **the token must sort strictly below its quote** (I-7),
 * so the launch token is always `currency0` and the pool price is always quote-per-token.
 * A salt that misses it reverts `TokenMustSortBelowQuote` at `launch`.
 *
 * A caller may pin an address SUFFIX on top of that (see ./suffix). Ordering alone is a
 * coin flip per attempt and lands in about two, which is why this loop is enough on its
 * own for a plain launch; a suffix multiplies the search by 16 per nibble, which is what
 * the WASM engine in ./mine-wasm exists for. `mineSalt` in ./mine picks between them.
 *
 * The one vanity shape deliberately NOT offered is a prefix. It constrains the same HIGH
 * nibbles the ordering rule does, so the two can contradict each other outright: the old
 * prefix miner's `0x1f60…` does not sort below Robinhood's wETH at `0x0Bd7…`, which meant
 * no wETH-quoted v2 coin could be created on that chain at all.
 *
 * Pure-local: fetch the init-code hash once, then grind with no RPC per attempt. The loop
 * hashes into one preallocated 85-byte buffer (`0xff ‖ deployer ‖ salt ‖ initCodeHash`,
 * exactly one keccak block) and compares the digest's low 20 bytes against the quote
 * byte-wise, so an attempt costs a keccak and nothing else.
 *
 * Runs anywhere: no worker_threads, no DOM, no WebAssembly.
 */
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { RallyError } from "./errors";
import { packSalt } from "./salt";
import {
  parseSuffix,
  suffixAttempts,
  suffixBytes,
  suffixMaxAttempts,
  type SaltSuffix,
} from "./suffix";

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
  /**
   * Pin the end of the address: hex nibbles, with or without `0x` (`"cafe"`, `"0000"`).
   * Omitted or empty means any address that satisfies ordering, which is the default and
   * costs about two attempts.
   *
   * Each nibble multiplies the search by 16, so this is what turns mining from free into
   * a progress bar: about 2 attempts for none, 131k for four nibbles, 33.5M for six.
   * `maxAttempts` defaults to 20x the mean for whatever is asked for, so a suffix does
   * not need a budget passed with it.
   */
  suffix?: string | SaltSuffix;
  /** First nonce to try. Shard workers by giving each a distinct start. */
  startNonce?: bigint;
  /** Nonce increment per attempt; set to the worker count to shard the space. */
  stride?: bigint;
  /** Attempts between event-loop yields; also the `onProgress` cadence. */
  batchSize?: number;
  /**
   * Give up after this many attempts. Defaults to 20x the expected attempts for the
   * requested suffix, which is a safety net rather than a budget: exhausting it means
   * the request is wrong, not that the grind was unlucky.
   */
  maxAttempts?: number;
  /** Set false to grind synchronously without yielding (backends only, it blocks). */
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
 * Grind creator-bound salts until the predicted token address sorts below `quote` and,
 * if one was asked for, ends in `suffix`.
 *
 * Throws `MINING_FAILED` when aborted or when `maxAttempts` is exhausted, rather than
 * returning a salt that would revert `TokenMustSortBelowQuote` on-chain.
 */
export async function mineSaltJs(opts: MineOptions): Promise<MineResult> {
  const { deployer, creator, initCodeHash, quote } = opts;
  const suffix = parseSuffix(opts.suffix);
  const stride = opts.stride ?? 1n;
  const batchSize = opts.batchSize ?? 20_000;
  const maxAttempts = opts.maxAttempts ?? suffixMaxAttempts(suffix?.nibbles ?? 0);
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

  // The suffix, as the trailing address bytes and the mask each is compared under (an
  // odd nibble count leaves the leading half byte unpinned). Walked from the end of the
  // digest, so `sufBytes[sufLen - 1 - i]` lines up with `digest[31 - i]`.
  const suf = suffix ? suffixBytes(suffix) : null;
  const sufBytes = suf?.bytes;
  const sufMasks = suf?.masks;
  const sufLen = suf ? suf.bytes.length : 0;

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

      // The suffix first: it rejects 15 of every 16 attempts per nibble for a couple of
      // byte compares, where ordering rejects about half.
      let hit = true;
      for (let b = 0; b < sufLen; b++) {
        const d = digest[31 - b]!;
        const want = sufBytes![sufLen - 1 - b]!;
        if ((d & sufMasks![sufLen - 1 - b]!) !== want) {
          hit = false;
          break;
        }
      }

      // The address is the digest's low 20 bytes, i.e. offset 12. Strictly below the
      // quote: equal is a revert too, and equality here would mean the launch token IS
      // the quote, which nothing downstream could make sense of.
      if (hit) {
        hit = false;
        for (let b = 0; b < 20; b++) {
          const a = digest[12 + b]!;
          const q = quoteBytes[b]!;
          if (a !== q) {
            hit = a < q;
            break;
          }
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
        suffix
          ? `No salt found in ${attempts} attempts for an address ending in "${suffix.hex}" ` +
            `that also sorts below ${quote}. That is ${Math.round(
              attempts / suffixAttempts(suffix.nibbles),
            )}x the expected attempts, so raise maxAttempts if you want to keep going.`
          : `No salt found in ${attempts} attempts whose address sorts below ${quote}. About ` +
            `half of all salts should qualify, so this many misses means the quote address ` +
            `is pathologically low, not that you were unlucky.`,
        { details: { attempts, quote, suffix: suffix?.hex } },
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
