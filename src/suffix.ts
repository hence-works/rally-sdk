/**
 * Address-suffix patterns for salt mining.
 *
 * A creator can ask for a launch token whose address ENDS in chosen hex, the way
 * `0x…0000` or `0x…dead` reads. The suffix is the only vanity shape Rally mines,
 * and that is a protocol constraint rather than a product one: the token must sort
 * strictly below its quote (I-7), which pins the address's HIGH nibbles, so a
 * prefix pattern and the ordering rule constrain the same bits and can be mutually
 * unsatisfiable. A pattern sorting above a quote made every launch on that quote
 * impossible, which is what retired the old prefix miner. A suffix constrains the
 * LOW nibbles, so the two predicates are independent and compose cleanly.
 *
 * Expected attempts are therefore `2 · 16^n`: one factor of 16 per pinned nibble,
 * times two for the ordering coin flip.
 */
import { RallyError } from "./errors";

/** The most nibbles either miner can carry: both hold the pattern in a u64. */
export const MAX_SUFFIX_NIBBLES = 16;

export interface SaltSuffix {
  /** Pinned nibble count, 1 to {@link MAX_SUFFIX_NIBBLES}. */
  nibbles: number;
  /** The pinned nibbles, right-aligned, for the WASM engine's `u64`. */
  value: bigint;
  /** Lowercase hex, no `0x`, exactly `nibbles` long. */
  hex: string;
}

/**
 * Parse a user-supplied suffix (`"cafe"`, `"0xCAFE"`, `"dead"`) into the form both
 * engines take. Throws `INVALID_SALT` on anything that is not hex, and on a pattern
 * longer than the engines can carry.
 *
 * An empty string is NOT an error: it parses to `null`, meaning "no suffix asked
 * for". A form field that starts empty is the normal case, and making the caller
 * branch on `""` before every call is how one of them forgets to.
 */
export function parseSuffix(suffix: string | SaltSuffix | null | undefined): SaltSuffix | null {
  if (suffix === null || suffix === undefined) return null;
  if (typeof suffix !== "string") {
    if (suffix.nibbles < 1 || suffix.nibbles > MAX_SUFFIX_NIBBLES) {
      throw new RallyError(
        "INVALID_SALT",
        `A suffix pins 1 to ${MAX_SUFFIX_NIBBLES} nibbles, got ${suffix.nibbles}.`,
      );
    }
    return suffix;
  }

  const hex = (suffix.startsWith("0x") || suffix.startsWith("0X") ? suffix.slice(2) : suffix)
    .trim()
    .toLowerCase();
  if (hex.length === 0) return null;
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new RallyError(
      "INVALID_SALT",
      `A suffix is hex: 0-9 and a-f only, so an address can actually end in it. Got "${suffix}".`,
      { details: { suffix } },
    );
  }
  if (hex.length > MAX_SUFFIX_NIBBLES) {
    throw new RallyError(
      "INVALID_SALT",
      `A suffix pins at most ${MAX_SUFFIX_NIBBLES} nibbles (both miners carry it in a ` +
        `u64), got ${hex.length}. Anything past 8 is hours of grinding in any case.`,
      { details: { suffix } },
    );
  }
  return { nibbles: hex.length, value: BigInt(`0x${hex}`), hex };
}

/**
 * Expected attempts for a suffix, including the ordering coin flip. This is a mean,
 * not a bound: the search is memoryless, so a run takes longer than this about 37%
 * of the time. Anything showing a creator an estimate should say "about".
 */
export function suffixAttempts(nibbles: number): number {
  return 2 * 16 ** nibbles;
}

/**
 * The floor under every mining budget, and the whole budget when no suffix is asked
 * for. It is NOT `20 · 2` attempts, because {@link suffixAttempts} assumes ordering
 * is a coin flip and that is only true of a mid-range quote: the odds are
 * `quote / 2^160`, so Robinhood's wETH at `0x0Bd7…` qualifies about 1 address in 22
 * and a 40-attempt budget would fail one launch in six on it. This is the budget the
 * miner has always carried for that case.
 */
export const MIN_MINE_ATTEMPTS = 1_000_000;

/**
 * A cap generous enough that exhausting it means something is wrong rather than
 * that the creator was unlucky: 20x the mean leaves a false failure at about 2e-9,
 * floored at {@link MIN_MINE_ATTEMPTS} for the low-quote case above.
 *
 * It scales because the miners' fixed default budget was a real bug source once a
 * suffix was in play. Grinding 6 nibbles has a mean of 33.5M attempts, so the old
 * flat 50M budget failed roughly one launch in five with `MINING_FAILED` and nothing
 * wrong with the request.
 */
export function suffixMaxAttempts(nibbles: number): number {
  return Math.max(MIN_MINE_ATTEMPTS, suffixAttempts(nibbles) * 20);
}

/**
 * Byte-wise form of a suffix for the pure-JS loop: the trailing bytes of the
 * address and the mask each one is compared under. An odd nibble count leaves a
 * half byte, whose high nibble is not pinned, so the leading entry is masked to
 * `0x0f`.
 *
 * Returned lowest-index-last: entry `i` is compared against address byte
 * `19 - i` counting from the end, which is how the hot loop walks it.
 */
export function suffixBytes(s: SaltSuffix): { bytes: Uint8Array; masks: Uint8Array } {
  const padded = s.nibbles % 2 === 1 ? `0${s.hex}` : s.hex;
  const len = padded.length / 2;
  const bytes = new Uint8Array(len);
  const masks = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    masks[i] = 0xff;
  }
  if (s.nibbles % 2 === 1) masks[0] = 0x0f;
  return { bytes, masks };
}
