import { createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner } from "@solana/kit";
import { RallyError } from "../errors";
import { addressBytes, sortsBelow } from "./address";

export interface GrindMintOptions {
  /**
   * Give up after this many keypairs. Default 100_000 (about 40 are needed against wSOL, whose
   * first byte is 0x06). With a `suffix`, six times the expected search, which succeeds about
   * 99.7% of the time: `6 * 58^length / P(a key sorts below the quote)`.
   */
  maxAttempts?: number;
  /** Seed source, 32 bytes per call. Defaults to `crypto.getRandomValues`; injectable for tests. */
  randomSeed?: () => Uint8Array;
  /** Whether the returned signer's private key stays exportable (default false). */
  extractable?: boolean;
  /**
   * Make the base58 address END with these characters (case-sensitive, 1 to 3 characters of the
   * base58 alphabet). Each character costs about 58x more attempts, multiplied by the ordering
   * rule's own cost (about 43x against wSOL, whose first byte is 0x06; a quote that sorts higher
   * costs less). A candidate is a WebCrypto keypair, around a thousand per second per thread, so
   * against wSOL one character takes seconds, two take minutes and three take hours: grind in a
   * Worker, pass `signal` to cancel and `onProgress` to show it. A SUFFIX (never a prefix) keeps
   * this compatible with I-7: ordering is decided by the high bytes of the key, the suffix by
   * the low ones, so the two costs multiply rather than conflict.
   */
  suffix?: string;
  /** Cancels the search; rejects with `MINING_FAILED`. */
  signal?: AbortSignal;
  /** Called every 1,000 attempts with the running count, so a UI can show progress. */
  onProgress?: (attempts: number) => void;
}

/** The longest suffix `grindMint` will search for. */
export const MAX_MINT_SUFFIX_LENGTH = 3;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export interface GroundMint {
  /** Signs `create_launch`: the mint account is created at this key, so only its holder can. */
  signer: KeyPairSigner;
  address: Address;
  /** The 32-byte ed25519 seed (the first half of a 64-byte Solana secret key). Handle as a secret. */
  seed: Uint8Array;
  attempts: number;
}

/**
 * Grind a mint keypair whose key bytes sort strictly BELOW `quoteMint` (I-7). Raydium
 * orders a pool's mints by key bytes and the curve needs the launch token as token_0, so a
 * mint sorting above its quote can never open its pool. Do this BEFORE pinning metadata at
 * `/<chainId>/<mint>.json`: the address is fixed by the keypair.
 *
 * With `suffix`, also grinds the base58 tail of the address. Unlike the EVM miner there is no
 * WASM engine behind this: every candidate is an ed25519 keypair, so the search is the plain
 * keypair loop, bounded to 3 characters because each one multiplies it by 58.
 */
export async function grindMint(quoteMint: Address, opts: GrindMintOptions = {}): Promise<GroundMint> {
  const suffix = opts.suffix;
  if (suffix !== undefined) {
    if (typeof suffix !== "string" || suffix.length < 1 || suffix.length > MAX_MINT_SUFFIX_LENGTH || !BASE58.test(suffix)) {
      throw new RallyError(
        "MINING_FAILED",
        `suffix must be 1 to ${MAX_MINT_SUFFIX_LENGTH} base58 characters (no 0, O, I or l; case-sensitive), got "${String(suffix).slice(0, 20)}"`,
        { details: { suffix: String(suffix).slice(0, 20) } },
      );
    }
  }
  // Expected attempts = 58^len / P(below quote); P is estimated from the quote's first four bytes.
  const quoteHigh = new DataView(addressBytes(quoteMint).buffer).getUint32(0, false);
  const max =
    opts.maxAttempts ?? (suffix ? Math.ceil((6 * 58 ** suffix.length * 2 ** 32) / Math.max(1, quoteHigh)) : 100_000);
  const next =
    opts.randomSeed ??
    (() => {
      const s = new Uint8Array(32);
      crypto.getRandomValues(s);
      return s;
    });
  for (let attempts = 1; attempts <= max; attempts++) {
    if (opts.signal?.aborted) throw new RallyError("MINING_FAILED", "Mint grinding was cancelled", { details: { attempts: attempts - 1 } });
    const seed = next();
    if (seed.length !== 32) throw new RallyError("MINING_FAILED", "randomSeed must return 32 bytes");
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, opts.extractable ?? false);
    if (suffix === undefined || signer.address.endsWith(suffix)) {
      if (sortsBelow(signer.address, quoteMint)) return { signer, address: signer.address, seed, attempts };
    }
    if (opts.onProgress && attempts % 1000 === 0) opts.onProgress(attempts);
  }
  throw new RallyError(
    "MINING_FAILED",
    `No mint ${suffix ? `ending in "${suffix}" and ` : ""}sorting below ${quoteMint} found in ${max} attempts`,
    { details: { quoteMint, attempts: max, ...(suffix ? { suffix } : {}) } },
  );
}
