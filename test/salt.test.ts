/**
 * The mining loop hashes into a hand-packed 85-byte buffer and tests the digest
 * byte-wise. That is the one place in this SDK where an off-by-one produces a
 * *plausible* address rather than an obvious failure — and a wrong address means a
 * launch that reverts VanityMismatch after the metadata has already been pinned. So
 * every result is cross-checked against viem's own `getCreate2Address`.
 */
import { describe, expect, it } from "vitest";
import { getCreate2Address, keccak256, toHex, type Address, type Hex } from "viem";
import { mineVanitySalt } from "../src/mine";
import {
  compileVanity,
  computeTokenAddress,
  formatVanity,
  matchesVanity,
  packSalt,
  saltCreator,
  vanityDifficulty,
  type Vanity,
} from "../src/salt";

const CREATOR: Address = "0x1111111111111111111111111111111111111111";
const DEPLOYER: Address = "0xA70e6e3D871687D1ddf8a9D493e33A67Ac066653";
const INIT_CODE_HASH = keccak256(toHex("RallyToken"));

const NO_VANITY: Vanity = { prefixLen: 0, prefixBits: 0n, suffixLen: 0, suffixBits: 0n };
/** The factory's default pattern: addresses starting `0x1f60`. */
const LFGO: Vanity = { prefixLen: 4, prefixBits: 0x1f60n, suffixLen: 0, suffixBits: 0n };

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

describe("compileVanity", () => {
  const check = (address: Address, v: Vanity) => {
    const bytes = hexToBytes(address);
    return compileVanity(v).checks.every(
      (c) => (bytes[c.index]! & c.mask) === c.expected,
    );
  };

  it("matches the string matcher on an odd-length prefix", () => {
    const v: Vanity = { prefixLen: 3, prefixBits: 0xba5n, suffixLen: 0, suffixBits: 0n };
    const hit: Address = "0xba5e000000000000000000000000000000000000";
    const miss: Address = "0xba4e000000000000000000000000000000000000";
    expect(check(hit, v)).toBe(matchesVanity(hit, v));
    expect(check(miss, v)).toBe(matchesVanity(miss, v));
    expect(check(hit, v)).toBe(true);
    expect(check(miss, v)).toBe(false);
  });

  it("matches the string matcher on an odd-length suffix", () => {
    const v: Vanity = { prefixLen: 0, prefixBits: 0n, suffixLen: 3, suffixBits: 0xf00n };
    const hit: Address = "0x0000000000000000000000000000000000000f00";
    const miss: Address = "0x0000000000000000000000000000000000000f01";
    expect(check(hit, v)).toBe(true);
    expect(matchesVanity(hit, v)).toBe(true);
    expect(check(miss, v)).toBe(false);
    expect(matchesVanity(miss, v)).toBe(false);
  });

  it("handles a prefix and suffix together", () => {
    const v: Vanity = { prefixLen: 2, prefixBits: 0xban, suffixLen: 2, suffixBits: 0x5en };
    expect(check("0xba0000000000000000000000000000000000005e", v)).toBe(true);
    expect(check("0xba0000000000000000000000000000000000005f", v)).toBe(false);
    expect(check("0xbb0000000000000000000000000000000000005e", v)).toBe(false);
  });

  it("reports no checks when nothing is pinned", () => {
    expect(compileVanity(NO_VANITY).empty).toBe(true);
  });
});

describe("mineVanitySalt", () => {
  it("returns a creator-bound salt whose address hits the pattern", async () => {
    const result = await mineVanitySalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      vanity: LFGO,
      yieldBetweenBatches: false,
    });

    // The address is what the chain will compute, and it satisfies the constraint.
    expect(result.address).toBe(
      getCreate2Address({ from: DEPLOYER, salt: result.salt, bytecodeHash: INIT_CODE_HASH }),
    );
    expect(matchesVanity(result.address, LFGO)).toBe(true);
    expect(saltCreator(result.salt).toLowerCase()).toBe(CREATOR.toLowerCase());
    expect(result.attempts).toBeGreaterThan(0);
  });

  it("mines a prefix+suffix pattern", async () => {
    const v: Vanity = { prefixLen: 2, prefixBits: 0xban, suffixLen: 2, suffixBits: 0x5en };
    const result = await mineVanitySalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      vanity: v,
      yieldBetweenBatches: false,
    });
    expect(matchesVanity(result.address, v)).toBe(true);
    expect(result.address).toBe(
      getCreate2Address({ from: DEPLOYER, salt: result.salt, bytecodeHash: INIT_CODE_HASH }),
    );
  });

  it("finds distinct salts from a sharded start, matching a single-threaded grind", async () => {
    const shard = await mineVanitySalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      vanity: LFGO,
      startNonce: 1n,
      stride: 4n,
      yieldBetweenBatches: false,
    });
    expect(matchesVanity(shard.address, LFGO)).toBe(true);
    // Sharded nonces stay on their own residue class, so they cannot collide.
    expect((BigInt(shard.salt) & ((1n << 96n) - 1n)) % 4n).toBe(1n);
  });

  it("carries correctly across the 48-bit nonce boundary", async () => {
    const start = (1n << 48n) - 3n;
    const result = await mineVanitySalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      vanity: LFGO,
      startNonce: start,
      yieldBetweenBatches: false,
    });
    expect(BigInt(result.salt) & ((1n << 96n) - 1n)).toBeGreaterThanOrEqual(start);
    expect(result.address).toBe(
      getCreate2Address({ from: DEPLOYER, salt: result.salt, bytecodeHash: INIT_CODE_HASH }),
    );
  });

  it("skips the grind entirely when no pattern is pinned", async () => {
    const result = await mineVanitySalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      vanity: NO_VANITY,
    });
    expect(result.attempts).toBe(0);
    expect(result.salt).toBe(packSalt(CREATOR, 0n));
  });

  it("throws rather than returning a salt that would revert", async () => {
    await expect(
      mineVanitySalt({
        deployer: DEPLOYER,
        creator: CREATOR,
        initCodeHash: INIT_CODE_HASH,
        // 8 nibbles ≈ 4.3e9 expected attempts — unreachable inside the budget below.
        vanity: { prefixLen: 8, prefixBits: 0xdeadbeefn, suffixLen: 0, suffixBits: 0n },
        maxAttempts: 1_000,
        batchSize: 500,
        yieldBetweenBatches: false,
      }),
    ).rejects.toThrow(/No vanity salt found/);
  });

  it("aborts on signal", async () => {
    const controller = new AbortController();
    const promise = mineVanitySalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      vanity: { prefixLen: 8, prefixBits: 0xdeadbeefn, suffixLen: 0, suffixBits: 0n },
      batchSize: 200,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
  });
});

describe("formatVanity / vanityDifficulty", () => {
  it("renders the pattern for display", () => {
    expect(formatVanity(LFGO)).toBe("0x1f60…");
    expect(formatVanity(NO_VANITY)).toBe("0x…");
    expect(
      formatVanity({ prefixLen: 2, prefixBits: 0xban, suffixLen: 2, suffixBits: 0x5en }),
    ).toBe("0xba…5e");
  });

  it("reports the expected attempt count", () => {
    expect(vanityDifficulty(LFGO)).toBe(65_536);
    expect(vanityDifficulty(NO_VANITY)).toBe(1);
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
