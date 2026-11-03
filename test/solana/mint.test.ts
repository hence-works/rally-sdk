import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { MAX_MINT_SUFFIX_LENGTH, RallyError, WSOL_MINT, grindMint, sortsBelow } from "../../src/solana";
import { addr } from "./fixtures";

describe("grindMint (I-7)", () => {
  it("returns a keypair whose address sorts below the quote, and whose seed reproduces it", async () => {
    const g = await grindMint(WSOL_MINT);
    expect(sortsBelow(g.address, WSOL_MINT)).toBe(true);
    expect(g.seed).toHaveLength(32);
    expect((await createKeyPairSignerFromPrivateKeyBytes(g.seed)).address).toBe(g.address);
    expect(g.attempts).toBeGreaterThanOrEqual(1);
  });
  it("is deterministic given a seed source, and counts attempts", async () => {
    let n = 0;
    const seeds = () => {
      n++;
      return new Uint8Array(32).fill(n);
    };
    const quote = addr(0x80);
    const a = await grindMint(quote, { randomSeed: seeds });
    n = 0;
    const b = await grindMint(quote, { randomSeed: seeds });
    expect(a.address).toBe(b.address);
    expect(sortsBelow(a.address, quote)).toBe(true);
    expect(a.attempts).toBe(n);
  });
  it("gives up with MINING_FAILED when nothing can sort below (all-zero quote)", async () => {
    await expect(grindMint(addr(0), { maxAttempts: 5 })).rejects.toMatchObject({ code: "MINING_FAILED" });
    await expect(grindMint(addr(0), { maxAttempts: 1, randomSeed: () => new Uint8Array(3) })).rejects.toBeInstanceOf(RallyError);
  });
});

describe("grindMint suffix", () => {
  /** A deterministic seed stream, so the search is reproducible. */
  const stream = () => {
    let n = 0;
    return () => {
      n++;
      const s = new Uint8Array(32);
      new DataView(s.buffer).setUint32(0, n, true);
      return s;
    };
  };

  // A high quote makes nearly every key sort below it, so these tests pay for the suffix alone.
  const HIGH = addr(0xff);

  it("preserves randomSeed as one legacy WebCrypto seed per candidate", async () => {
    const seed = new Uint8Array(32).fill(7);
    const expected = await createKeyPairSignerFromPrivateKeyBytes(seed);
    let calls = 0;
    const result = await grindMint(HIGH, {
      suffix: expected.address.slice(-1),
      maxAttempts: 1,
      randomSeed: () => {
        calls++;
        return seed;
      },
    });
    expect(result.address).toBe(expected.address);
    expect(result.nonce).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("returns a key ending in the suffix that still sorts below the quote (I-7), against wSOL", async () => {
    const g = await grindMint(WSOL_MINT, { suffix: "z", randomSeed: stream() });
    expect(g.address.endsWith("z")).toBe(true);
    expect(sortsBelow(g.address, WSOL_MINT)).toBe(true);
    expect((await createKeyPairSignerFromPrivateKeyBytes(g.seed)).address).toBe(g.address);
  }, 60_000);

  it("a two character suffix is found, deterministically", async () => {
    const a = await grindMint(HIGH, { suffix: "Rx", randomSeed: stream() });
    const b = await grindMint(HIGH, { suffix: "Rx", randomSeed: stream() });
    expect(a.address.endsWith("Rx")).toBe(true);
    expect(a.address).toBe(b.address);
    expect(a.attempts).toBe(b.attempts);
    // Two base58 characters against the I-7 bound is ~58^2 x 43 keypairs: seconds locally,
    // past vitest's 5 s default on a shared CI runner.
  }, 60_000);

  it("is case-sensitive: base58 distinguishes a from A", async () => {
    const lower = await grindMint(HIGH, { suffix: "a", randomSeed: stream() });
    const upper = await grindMint(HIGH, { suffix: "A", randomSeed: stream() });
    expect(lower.address.endsWith("a")).toBe(true);
    expect(upper.address.endsWith("A")).toBe(true);
    expect(lower.address).not.toBe(upper.address);
  });

  it("composes with ordering: an unorderable quote exhausts instead of returning a bad mint", async () => {
    await expect(grindMint(addr(0), { suffix: "a", maxAttempts: 300, randomSeed: stream() })).rejects.toMatchObject({ code: "MINING_FAILED" });
  });

  it("accepts up to five base58 characters and rejects anything longer", async () => {
    expect(MAX_MINT_SUFFIX_LENGTH).toBe(5);
    await expect(grindMint(addr(0), { suffix: "abcde", maxAttempts: 1, randomSeed: stream() })).rejects.toMatchObject({
      code: "MINING_FAILED",
      details: { attempts: 1, suffix: "abcde" },
    });
    await expect(grindMint(WSOL_MINT, { suffix: "abcdef" })).rejects.toMatchObject({
      code: "MINING_FAILED",
      details: { suffix: "abcdef" },
    });

    for (const suffix of ["", "0", "O", "I", "l", "a!", "a b"]) {
      await expect(grindMint(WSOL_MINT, { suffix })).rejects.toMatchObject({ code: "MINING_FAILED" });
    }
    await expect(grindMint(WSOL_MINT, { suffix: 5 as never })).rejects.toMatchObject({ code: "MINING_FAILED" });
  });

  it("gives up with MINING_FAILED, and can be cancelled", async () => {
    await expect(grindMint(WSOL_MINT, { suffix: "zzz", maxAttempts: 50, randomSeed: stream() })).rejects.toMatchObject({ code: "MINING_FAILED" });
    const ac = new AbortController();
    ac.abort();
    await expect(grindMint(WSOL_MINT, { suffix: "zz", signal: ac.signal })).rejects.toMatchObject({ code: "MINING_FAILED" });
  });

  it("reports progress", async () => {
    const seen: number[] = [];
    await expect(grindMint(HIGH, { suffix: "zzz", maxAttempts: 2500, randomSeed: stream(), onProgress: (n) => seen.push(n) })).rejects.toBeInstanceOf(RallyError);
    expect(seen).toEqual([1000, 2000]);
  });
});

describe("sortsBelow", () => {
  it("compares raw key bytes, big-endian, strictly", () => {
    expect(sortsBelow(addr(1), addr(2))).toBe(true);
    expect(sortsBelow(addr(2), addr(1))).toBe(false);
    expect(sortsBelow(addr(1), addr(1))).toBe(false);
  });
});
