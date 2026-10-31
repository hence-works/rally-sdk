import { createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner } from "@solana/kit";
import { RallyError } from "../errors";
import { sortsBelow } from "./address";

export interface GrindMintOptions {
  /** Give up after this many keypairs (default 100_000; ~40 are needed against wSOL). */
  maxAttempts?: number;
  /** Seed source, 32 bytes per call. Defaults to `crypto.getRandomValues`; injectable for tests. */
  randomSeed?: () => Uint8Array;
  /** Whether the returned signer's private key stays exportable (default false). */
  extractable?: boolean;
}

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
 * Unlike the EVM miner there is no vanity engine here yet: Solana vanity suffixes would be
 * ed25519 grinding, which is a different (and much heavier) search.
 */
export async function grindMint(quoteMint: Address, opts: GrindMintOptions = {}): Promise<GroundMint> {
  const max = opts.maxAttempts ?? 100_000;
  const next =
    opts.randomSeed ??
    (() => {
      const s = new Uint8Array(32);
      crypto.getRandomValues(s);
      return s;
    });
  for (let attempts = 1; attempts <= max; attempts++) {
    const seed = next();
    if (seed.length !== 32) throw new RallyError("MINING_FAILED", "randomSeed must return 32 bytes");
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, opts.extractable ?? false);
    if (sortsBelow(signer.address, quoteMint)) return { signer, address: signer.address, seed, attempts };
  }
  throw new RallyError("MINING_FAILED", `No mint sorting below ${quoteMint} found in ${max} attempts`, {
    details: { quoteMint, attempts: max },
  });
}
