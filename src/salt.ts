/**
 * Creator-bound launch salts and the factory's address-vanity constraint.
 *
 * `RallyFactory.launch(name, symbol, metadataURI, salt, …)` deploys the ERC-20 with
 * CREATE2, and the salt is mined off-chain so the token lands at a vanity address
 * (by default `0x1f60…`). Two properties follow, and both matter to an integrator:
 *
 *   - the address is a pure function of the salt, so it is knowable *before* the
 *     launch transaction — which is what lets metadata be pinned at
 *     `/<chainId>/<token>.json` up front (an unresolvable metadataURI is permanent); and
 *   - the salt's high 20 bytes must equal `msg.sender`, so the address commits to its
 *     creator and a mempool watcher cannot replay public calldata to steal it.
 */
import { getCreate2Address, numberToHex, type Address, type Hex } from "viem";

const NONCE_MASK = (1n << 96n) - 1n;

/**
 * Build a creator-bound salt: high 20 bytes `creator`, low 12 bytes `nonce`. Mirrors
 * `RallyFactory.packSalt`. `launch` rejects any salt whose high bytes aren't the
 * sender, so vanity mining fixes these high bytes and grinds only the nonce.
 */
export function packSalt(creator: Address, nonce: bigint): Hex {
  return numberToHex((BigInt(creator) << 96n) | (nonce & NONCE_MASK), { size: 32 });
}

/** The creator a salt is bound to — mirrors `RallyFactory.saltCreator`. */
export function saltCreator(salt: Hex): Address {
  return numberToHex(BigInt(salt) >> 96n, { size: 20 });
}

/** The vanity constraint as stored on-chain (`RallyFactory.AddrVanity`). */
export interface Vanity {
  /** leading hex nibbles pinned (0 = no prefix) */
  prefixLen: number;
  /** required leading nibbles, right-aligned */
  prefixBits: bigint;
  /** trailing hex nibbles pinned (0 = no suffix) */
  suffixLen: number;
  /** required trailing nibbles, right-aligned */
  suffixBits: bigint;
}

/** The CREATE2 address for a salt, given the token init-code hash (pure, local). */
export function computeTokenAddress(
  deployer: Address,
  salt: Hex,
  initCodeHash: Hex,
): Address {
  return getCreate2Address({ from: deployer, salt, bytecodeHash: initCodeHash });
}

/** Lowercased hex fragments an address must match, or null for an empty side. */
function matchers(v: Vanity): { prefix: string | null; suffix: string | null } {
  return {
    prefix:
      v.prefixLen > 0 ? "0x" + v.prefixBits.toString(16).padStart(v.prefixLen, "0") : null,
    suffix: v.suffixLen > 0 ? v.suffixBits.toString(16).padStart(v.suffixLen, "0") : null,
  };
}

/** Whether `address` satisfies the pattern (case-insensitive). */
export function matchesVanity(address: Address, v: Vanity): boolean {
  const { prefix, suffix } = matchers(v);
  const a = address.toLowerCase();
  return (!prefix || a.startsWith(prefix)) && (!suffix || a.endsWith(suffix));
}

/** Human display of the pattern, e.g. `0x1f60…` (or `0x…` when unset). */
export function formatVanity(v: Vanity): string {
  const { prefix, suffix } = matchers(v);
  return `${prefix ?? "0x"}…${suffix ?? ""}`;
}

/** Expected difficulty: mean CREATE2 attempts to satisfy the pattern. */
export function vanityDifficulty(v: Vanity): number {
  return 16 ** (v.prefixLen + v.suffixLen);
}

/**
 * A byte-wise form of the pattern, so the mining loop can test a raw keccak digest
 * without allocating a hex string per attempt — the single biggest cost in the grind.
 * Each entry is `(address[index] & mask) === expected`.
 */
export interface CompiledVanity {
  checks: { index: number; mask: number; expected: number }[];
  /** True when nothing is pinned — any salt works, so don't spin. */
  empty: boolean;
}

export function compileVanity(v: Vanity): CompiledVanity {
  // An address is 40 hex nibbles over 20 bytes: nibble i lives in byte i>>1, high
  // half when i is even.
  const perByte = new Map<number, { mask: number; expected: number }>();
  const put = (nibbleIndex: number, value: number) => {
    const index = nibbleIndex >> 1;
    const high = (nibbleIndex & 1) === 0;
    const entry = perByte.get(index) ?? { mask: 0, expected: 0 };
    entry.mask |= high ? 0xf0 : 0x0f;
    entry.expected |= high ? value << 4 : value;
    perByte.set(index, entry);
  };

  for (let i = 0; i < v.prefixLen; i++) {
    const shift = BigInt(4 * (v.prefixLen - 1 - i));
    put(i, Number((v.prefixBits >> shift) & 0xfn));
  }
  for (let k = 0; k < v.suffixLen; k++) {
    const shift = BigInt(4 * (v.suffixLen - 1 - k));
    put(40 - v.suffixLen + k, Number((v.suffixBits >> shift) & 0xfn));
  }

  return {
    checks: [...perByte.entries()].map(([index, e]) => ({ index, ...e })),
    empty: v.prefixLen === 0 && v.suffixLen === 0,
  };
}
