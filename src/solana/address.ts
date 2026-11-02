import { getAddressEncoder, isAddress, type Address } from "@solana/kit";
import { RallyError } from "../errors";
import { vmOf } from "./constants";

/**
 * Validate a Solana key: base58 that decodes to exactly 32 bytes. Returned UNCHANGED:
 * base58 is case-sensitive, so `toLowerCase()` on a key corrupts it.
 */
export function normalizeSolanaAddress(value: string): Address {
  if (typeof value === "string" && isAddress(value)) return value;
  throw new RallyError("INVALID_ADDRESS", `Not a Solana address (base58, 32 bytes): "${String(value).slice(0, 60)}"`, {
    details: { value: String(value).slice(0, 60) },
  });
}

/**
 * The one comparison/storage-key function for addresses of either VM, mirroring the
 * indexer and API: EVM lowercases, SVM validates and returns the key unchanged.
 */
export function normalizeAddress(vm: "evm" | "svm", value: string): string {
  if (vm === "svm") return normalizeSolanaAddress(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new RallyError("INVALID_ADDRESS", `Not an EVM address: "${String(value).slice(0, 60)}"`);
  }
  return value.toLowerCase();
}

/** `normalizeAddress` keyed by chain id (`vmOf`). */
export function normalizeAddressForChain(chainId: number, value: string): string {
  return normalizeAddress(vmOf(chainId), value);
}

/** Raw 32 key bytes, for byte-order comparisons (I-7). */
export function addressBytes(value: Address): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(value));
}

/** True when `a` sorts strictly below `b` by key bytes (Raydium orders pool mints this way). */
export function sortsBelow(a: Address, b: Address): boolean {
  const x = addressBytes(a);
  const y = addressBytes(b);
  for (let i = 0; i < 32; i++) {
    if (x[i]! !== y[i]!) return x[i]! < y[i]!;
  }
  return false;
}
