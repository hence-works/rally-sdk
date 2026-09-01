/**
 * The mining loop hashes into a hand-packed 85-byte buffer and compares the digest's low
 * 20 bytes against the quote. That is the one place in this SDK where an off-by-one
 * produces a *plausible* address rather than an obvious failure — and a wrong address
 * means a launch that reverts `TokenMustSortBelowQuote` after the metadata has already
 * been pinned. So every result is cross-checked against viem's own `getCreate2Address`.
 */
import { describe, expect, it } from "vitest";
import { getCreate2Address, keccak256, toHex, type Address, type Hex } from "viem";
import { mineSalt } from "../src/mine-core";
import { computeTokenAddress, packSalt, saltCreator } from "../src/salt";

const CREATOR: Address = "0x1111111111111111111111111111111111111111";
const DEPLOYER: Address = "0xA70e6e3D871687D1ddf8a9D493e33A67Ac066653";
const INIT_CODE_HASH = keccak256(toHex("RallyToken"));

/** A mid-range quote: about half of all addresses sort below it. */
const QUOTE: Address = "0x8888888888888888888888888888888888888888";
const below = (a: Address, q: Address) => a.toLowerCase() < q.toLowerCase();

describe("packSalt", () => {
  it("puts the creator in the high 20 bytes and the nonce in the low 12", () => {
    const salt = packSalt(CREATOR, 42n);
    expect(salt).toBe("0x1111111111111111111111111111111111111111" + "00000000000000000000002a");
    expect(saltCreator(salt).toLowerCase()).toBe(CREATOR.toLowerCase());
  });

  it("truncates a nonce wider than 96 bits rather than corrupting the creator", () => {
    const salt = packSalt(CREATOR, (1n << 96n) + 7n);
    expect(saltCreator(salt).toLowerCase()).toBe(CREATOR.toLowerCase());
    expect(salt.endsWith("000000000000000000000007")).toBe(true);
  });
});

describe("computeTokenAddress", () => {
  it("agrees with viem's getCreate2Address", () => {
    for (let n = 0n; n < 20n; n++) {
      const salt = packSalt(CREATOR, n);
      expect(computeTokenAddress(DEPLOYER, salt, INIT_CODE_HASH)).toBe(
        getCreate2Address({ from: DEPLOYER, salt, bytecodeHash: INIT_CODE_HASH }),
      );
    }
  });
});

describe("mineSalt", () => {
  it("returns a creator-bound salt whose address sorts below the quote", async () => {
    const result = await mineSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: QUOTE,
      yieldBetweenBatches: false,
    });

    // The address is what the chain will compute, and it satisfies I-7.
    expect(result.address).toBe(
      getCreate2Address({ from: DEPLOYER, salt: result.salt, bytecodeHash: INIT_CODE_HASH }),
    );
    expect(below(result.address, QUOTE)).toBe(true);
    expect(saltCreator(result.salt).toLowerCase()).toBe(CREATOR.toLowerCase());
    expect(result.attempts).toBeGreaterThan(0);
  });

  /// A low quote is the case that used to be unsatisfiable under the old vanity prefix.
  it("satisfies a very low quote, which the vanity prefix made impossible", async () => {
    const low: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; // Robinhood wETH
    const result = await mineSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: low,
      yieldBetweenBatches: false,
    });
    expect(below(result.address, low)).toBe(true);
    expect(result.address).toBe(
      getCreate2Address({ from: DEPLOYER, salt: result.salt, bytecodeHash: INIT_CODE_HASH }),
    );
  });

  it("finds distinct salts from a sharded start, staying on its residue class", async () => {
    const shard = await mineSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: QUOTE,
      startNonce: 1n,
      stride: 4n,
      yieldBetweenBatches: false,
    });
    expect(below(shard.address, QUOTE)).toBe(true);
    expect((BigInt(shard.salt) & ((1n << 96n) - 1n)) % 4n).toBe(1n);
  });

  it("carries correctly across the 48-bit nonce boundary", async () => {
    const start = (1n << 48n) - 3n;
    const result = await mineSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: QUOTE,
      startNonce: start,
      yieldBetweenBatches: false,
    });
    expect(BigInt(result.salt) & ((1n << 96n) - 1n)).toBeGreaterThanOrEqual(start);
    expect(result.address).toBe(
      getCreate2Address({ from: DEPLOYER, salt: result.salt, bytecodeHash: INIT_CODE_HASH }),
    );
  });

  /// The zero address has nothing below it, so no salt can ever qualify. Throwing beats
  /// returning one that reverts on-chain after a pin.
  it("throws rather than returning a salt that would revert", async () => {
    await expect(
      mineSalt({
        deployer: DEPLOYER,
        creator: CREATOR,
        initCodeHash: INIT_CODE_HASH,
        quote: "0x0000000000000000000000000000000000000000",
        maxAttempts: 1_000,
        batchSize: 500,
        yieldBetweenBatches: false,
      }),
    ).rejects.toThrow(/No salt found/);
  });

  it("aborts on signal", async () => {
    const controller = new AbortController();
    const promise = mineSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: "0x0000000000000000000000000000000000000000",
      batchSize: 200,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
  });
});

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
