import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { RallyError, WSOL_MINT, grindMint, sortsBelow } from "../../src/solana";
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

describe("sortsBelow", () => {
  it("compares raw key bytes, big-endian, strictly", () => {
    expect(sortsBelow(addr(1), addr(2))).toBe(true);
    expect(sortsBelow(addr(2), addr(1))).toBe(false);
    expect(sortsBelow(addr(1), addr(1))).toBe(false);
  });
});
