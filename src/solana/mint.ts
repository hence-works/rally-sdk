import { createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner } from "@solana/kit";
import { RallyError } from "../errors";
import { addressBytes, sortsBelow } from "./address";
import { instantiateMintWasm, mineMintSuffixWasm, type MintWasmExports } from "./mint-wasm";

export interface GrindMintOptions {
  /**
   * Give up after this many keypairs. Default 100_000 (about 40 are needed against wSOL, whose
   * first byte is 0x06). With a `suffix`, six times the expected search, which succeeds about
   * 99.7% of the time: `6 * 58^length / P(a key sorts below the quote)`.
   */
  maxAttempts?: number;
  /** Seed source, 32 bytes per call. Defaults to `crypto.getRandomValues`; injectable for tests. */
  randomSeed?: () => Uint8Array;
  /** Shared 32-byte WASM master for deterministic worker shards. Generated securely by default. */
  masterSeed?: Uint8Array;
  /** Whether the returned signer's private key stays exportable (default false). */
  extractable?: boolean;
  /**
   * Make the base58 address END with these characters (case-sensitive, 1 to 5 characters of the
   * base58 alphabet). Each character costs about 58x more attempts, multiplied by the ordering
   * rule's own cost (about 39x against wSOL, whose first byte is 0x06; a quote that sorts higher
   * costs less). Suffix searches use the embedded Rust/WASM engine and fall back to WebCrypto
   * when WebAssembly cannot instantiate. Run long searches in a Worker, pass `signal` to cancel,
   * and use `onProgress` to show progress. A SUFFIX (never a prefix) keeps
   * this compatible with I-7: ordering is decided by the high bytes of the key, the suffix by
   * the low ones, so the two costs multiply rather than conflict.
   */
  suffix?: string;
  /** Cancels the search; rejects with `MINING_FAILED`. */
  signal?: AbortSignal;
  /** Called periodically with the running attempt count, so a UI can show progress. */
  onProgress?: (attempts: number) => void;
  /** First nonce for deterministic WASM worker sharding (default 0). */
  startNonce?: bigint;
  /** Nonce distance between this worker's candidates (default 1). */
  stride?: bigint;
  /** Attempts between progress updates and cancellation yields in the WASM engine. */
  chunkSize?: number;
}

/** The longest suffix `grindMint` will search for. */
export const MAX_MINT_SUFFIX_LENGTH = 5;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export interface GroundMint {
  /** Signs `create_launch`: the mint account is created at this key, so only its holder can. */
  signer: KeyPairSigner;
  address: Address;
  /** The 32-byte ed25519 seed (the first half of a 64-byte Solana secret key). Handle as a secret. */
  seed: Uint8Array;
  attempts: number;
  /** Winning suffix-search nonce. Absent when no suffix was requested. */
  nonce?: bigint;
}

/**
 * Grind a mint keypair whose key bytes sort strictly BELOW `quoteMint` (I-7). Raydium
 * orders a pool's mints by key bytes and the curve needs the launch token as token_0, so a
 * mint sorting above its quote can never open its pool. Do this BEFORE pinning metadata at
 * `/<chainId>/<mint>.json`: the address is fixed by the keypair.
 *
 * With `suffix`, also grinds the base58 tail of the address using an embedded Rust/WASM engine.
 * The result is independently reconstructed and checked before its signer is returned. A runtime
 * without WebAssembly safely falls back to the plain WebCrypto keypair loop.
 */
async function grindMintWebCrypto(
  quoteMint: Address,
  suffix: string | undefined,
  max: number,
  opts: GrindMintOptions,
  next: () => Uint8Array,
): Promise<GroundMint> {
  for (let attempts = 1; attempts <= max; attempts++) {
    if (opts.signal?.aborted) throw new RallyError("MINING_FAILED", "Mint grinding was cancelled", { details: { attempts: attempts - 1 } });
    const seed = next();
    if (seed.length !== 32) throw new RallyError("MINING_FAILED", "randomSeed must return 32 bytes");
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, opts.extractable ?? false);
    if (opts.signal?.aborted) throw new RallyError("MINING_FAILED", "Mint grinding was cancelled", { details: { attempts: attempts - 1 } });
    if (suffix === undefined || signer.address.endsWith(suffix)) {
      if (sortsBelow(signer.address, quoteMint)) return { signer, address: signer.address, seed, attempts };
    }
    if (opts.onProgress && attempts % 1000 === 0) opts.onProgress(attempts);
  }
  throw exhausted(quoteMint, suffix, max);
}

async function grindMintWebCryptoSuffix(
  quoteMint: Address,
  suffix: string,
  masterSeed: Uint8Array,
  max: number,
  opts: GrindMintOptions,
): Promise<GroundMint> {
  const startNonce = opts.startNonce ?? 0n;
  const stride = opts.stride ?? 1n;
  const maxU64 = (1n << 64n) - 1n;
  if (
    startNonce < 0n ||
    startNonce > maxU64 ||
    stride < 1n ||
    stride > maxU64 ||
    startNonce + BigInt(max - 1) * stride > maxU64
  ) {
    throw new RallyError("MINING_FAILED", "The requested Solana vanity nonce range exceeds 64 bits");
  }
  const input = new Uint8Array(40);
  input.set(masterSeed);
  try {
    for (let attempts = 1; attempts <= max; attempts++) {
      if (opts.signal?.aborted) throw new RallyError("MINING_FAILED", "Mint grinding was cancelled", { details: { attempts: attempts - 1 } });
      const nonce = startNonce + BigInt(attempts - 1) * stride;
      new DataView(input.buffer).setBigUint64(32, nonce, true);
      const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
      let keepSeed = false;
      try {
        if (opts.signal?.aborted) {
          throw new RallyError("MINING_FAILED", "Mint grinding was cancelled", { details: { attempts: attempts - 1 } });
        }
        const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, opts.extractable ?? false);
        if (opts.signal?.aborted) {
          throw new RallyError("MINING_FAILED", "Mint grinding was cancelled", { details: { attempts: attempts - 1 } });
        }
        if (signer.address.endsWith(suffix) && sortsBelow(signer.address, quoteMint)) {
          keepSeed = true;
          return { signer, address: signer.address, seed, attempts, nonce };
        }
      } finally {
        if (!keepSeed) seed.fill(0);
      }
      if (opts.onProgress && attempts % 1000 === 0) opts.onProgress(attempts);
    }
    throw exhausted(quoteMint, suffix, max);
  } finally {
    input.fill(0);
  }
}

function exhausted(quoteMint: Address, suffix: string | undefined, max: number): RallyError {
  return new RallyError(
    "MINING_FAILED",
    `No mint ${suffix ? `ending in "${suffix}" and ` : ""}sorting below ${quoteMint} found in ${max} attempts`,
    { details: { quoteMint, attempts: max, ...(suffix ? { suffix } : {}) } },
  );
}

/** Internal injection boundary used to verify automatic WASM fallback. */
export async function grindMintWithWasmFallback(
  quoteMint: Address,
  opts: GrindMintOptions = {},
  instantiate: () => Promise<MintWasmExports> = instantiateMintWasm,
): Promise<GroundMint> {
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
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RallyError("MINING_FAILED", "maxAttempts must be a positive safe integer");
  }
  const next =
    opts.randomSeed ??
    (() => {
      const s = new Uint8Array(32);
      crypto.getRandomValues(s);
      return s;
    });
  if (suffix === undefined) return grindMintWebCrypto(quoteMint, suffix, max, opts, next);
  // `randomSeed` predates the WASM engine and is documented as one seed per candidate. Keep that
  // deterministic contract. Worker shards use the explicit `masterSeed` option instead.
  if (opts.randomSeed && !opts.masterSeed) return grindMintWebCrypto(quoteMint, suffix, max, opts, next);

  const masterSeed = (opts.masterSeed ?? next()).slice();
  if (masterSeed.length !== 32) throw new RallyError("MINING_FAILED", "masterSeed must contain 32 bytes");
  if (!masterSeed.some((byte) => byte !== 0)) throw new RallyError("MINING_FAILED", "masterSeed must not be all zeroes");
  try {
    // No public key can sort strictly below the zero address. Keep this synthetic/test boundary
    // on the parity fallback because the WASM module rejects an unsearchable zero quote at setup.
    if (!addressBytes(quoteMint).some((byte) => byte !== 0)) {
      return await grindMintWebCryptoSuffix(quoteMint, suffix, masterSeed, max, opts);
    }
    let wasm: MintWasmExports;
    try {
      wasm = await instantiate();
    } catch {
      return grindMintWebCryptoSuffix(quoteMint, suffix, masterSeed, max, opts);
    }
    return await mineMintSuffixWasm(quoteMint, suffix, {
      masterSeed,
      maxAttempts: max,
      startNonce: opts.startNonce,
      stride: opts.stride,
      chunkSize: opts.chunkSize,
      extractable: opts.extractable,
      signal: opts.signal,
      onProgress: opts.onProgress,
      instantiate: async () => wasm,
    });
  } finally {
    masterSeed.fill(0);
  }
}

export async function grindMint(quoteMint: Address, opts: GrindMintOptions = {}): Promise<GroundMint> {
  return grindMintWithWasmFallback(quoteMint, opts);
}
