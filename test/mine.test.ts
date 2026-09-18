/**
 * Two engines grind the same two predicates, and this file is the only thing standing
 * between them and a silent disagreement.
 *
 * The WASM module (packages/vanity-miner) carries its own fully-unrolled Keccak-f[1600].
 * A wrong rho or pi offset in that permutation does not fail: it produces plausible
 * addresses that are not the ones the chain will compute, so a launch reverts AFTER the
 * metadata has been pinned at a dead address. Nothing recovers a pin, which is why the
 * permutation is cross-checked against viem here, and why both engines are pinned to the
 * same salt for the same inputs.
 */
import { describe, expect, it } from "vitest";
import { getCreate2Address, keccak256, toHex, type Address } from "viem";
import { mineSaltJs } from "../src/mine-core";
import { mineSalt, selectMineEngine } from "../src/mine";
import {
  isWasmMinerAvailable,
  mineSaltWasm,
  wasmCreate2Address,
} from "../src/mine-wasm";
import { packSalt, randomNonce, saltCreator } from "../src/salt";
import {
  MAX_SUFFIX_NIBBLES,
  MIN_MINE_ATTEMPTS,
  parseSuffix,
  suffixAttempts,
  suffixMaxAttempts,
} from "../src/suffix";

const CREATOR: Address = "0x1111111111111111111111111111111111111111";
const DEPLOYER: Address = "0xA70e6e3D871687D1ddf8a9D493e33A67Ac066653";
const INIT_CODE_HASH = keccak256(toHex("RallyToken"));

/** A mid-range quote: about half of all addresses sort below it. */
const QUOTE: Address = "0x8888888888888888888888888888888888888888";
const below = (a: Address, q: Address) => a.toLowerCase() < q.toLowerCase();
const endsWith = (a: Address, hex: string) => a.toLowerCase().endsWith(hex.toLowerCase());

describe("parseSuffix", () => {
  it("reads hex with or without 0x, case insensitively", () => {
    expect(parseSuffix("cafe")).toEqual({ nibbles: 4, value: 0xcafen, hex: "cafe" });
    expect(parseSuffix("0xCAFE")).toEqual({ nibbles: 4, value: 0xcafen, hex: "cafe" });
    expect(parseSuffix("0")).toEqual({ nibbles: 1, value: 0n, hex: "0" });
  });

  /// Empty is "no suffix asked for", not an error: a form field starts empty, and making
  /// every caller branch on "" first is how one of them forgets to.
  it("treats empty, null and undefined as no suffix", () => {
    expect(parseSuffix("")).toBeNull();
    expect(parseSuffix(null)).toBeNull();
    expect(parseSuffix(undefined)).toBeNull();
  });

  it("rejects anything an address cannot end in", () => {
    expect(() => parseSuffix("rally")).toThrow(/hex/i);
    expect(() => parseSuffix("ca fe")).toThrow(/hex/i);
    expect(() => parseSuffix("0x")).not.toThrow(); // bare prefix is just empty
    expect(() => parseSuffix("f".repeat(MAX_SUFFIX_NIBBLES + 1))).toThrow(/at most/);
  });

  /// Leading zeroes are load-bearing: "00ff" and "ff" are different patterns, and a
  /// BigInt round trip loses the difference. The nibble count is what carries it.
  it("keeps leading zeroes as pinned nibbles", () => {
    expect(parseSuffix("00ff")).toEqual({ nibbles: 4, value: 0xffn, hex: "00ff" });
  });
});

describe("suffix difficulty", () => {
  it("is 2 x 16^n attempts, the ordering coin flip included", () => {
    expect(suffixAttempts(0)).toBe(2);
    expect(suffixAttempts(4)).toBe(131_072);
    expect(suffixAttempts(6)).toBe(33_554_432);
  });

  /// The budget used to be a flat 50M, which is only 1.5x the mean for six nibbles: one
  /// launch in five failed with MINING_FAILED and nothing wrong with the request.
  it("budgets a generous multiple of the mean", () => {
    expect(suffixMaxAttempts(6)).toBe(suffixAttempts(6) * 20);
  });

  /// And never less than the floor. `suffixAttempts(0)` is 2 because ordering against a
  /// mid-range quote is a coin flip, but against a low one it is 1 in 22, so a budget
  /// derived from the mean alone would fail a wETH-quoted launch on Robinhood outright.
  it("never budgets below the floor, whatever the mean says", () => {
    expect(suffixMaxAttempts(0)).toBe(MIN_MINE_ATTEMPTS);
    expect(suffixMaxAttempts(3)).toBe(MIN_MINE_ATTEMPTS);
  });
});

describe("the WASM keccak", () => {
  it("is available in this runtime", async () => {
    expect(await isWasmMinerAvailable()).toBe(true);
  });

  /// The permutation guard. Random salts rather than a fixed vector: an offset that is
  /// wrong for some lane positions and right for others survives a single sample.
  it("agrees with viem's getCreate2Address over 500 random preimages", async () => {
    for (let i = 0; i < 500; i++) {
      const salt = packSalt(CREATOR, BigInt(Math.floor(Math.random() * 2 ** 48)));
      const hash = keccak256(toHex(`init-${i}`));
      const mine = await wasmCreate2Address(DEPLOYER, salt, hash);
      expect(mine.toLowerCase()).toBe(
        getCreate2Address({ from: DEPLOYER, salt, bytecodeHash: hash }).toLowerCase(),
      );
    }
  });
});

describe.each([
  ["wasm", mineSaltWasm],
  ["js", mineSaltJs],
] as const)("%s engine", (_name, mine) => {
  const base = {
    deployer: DEPLOYER,
    creator: CREATOR,
    initCodeHash: INIT_CODE_HASH,
    quote: QUOTE,
    yieldBetweenBatches: false,
  };

  it("mines an address that ends in the suffix AND sorts below the quote", async () => {
    const result = await mine({ ...base, suffix: "abc" });
    expect(endsWith(result.address, "abc")).toBe(true);
    expect(below(result.address, QUOTE)).toBe(true);
    expect(saltCreator(result.salt).toLowerCase()).toBe(CREATOR.toLowerCase());
    // The address the chain will compute, not just the one the miner believes in.
    expect(result.address.toLowerCase()).toBe(
      getCreate2Address({
        from: DEPLOYER,
        salt: result.salt,
        bytecodeHash: INIT_CODE_HASH,
      }).toLowerCase(),
    );
  });

  /// An odd nibble count leaves a half byte whose high nibble is not pinned. Both
  /// engines mask for it, and both get it wrong in the same plausible way if the mask
  /// lands on the wrong end.
  it("handles an odd nibble count", async () => {
    const result = await mine({ ...base, suffix: "7" });
    expect(endsWith(result.address, "7")).toBe(true);
    expect(below(result.address, QUOTE)).toBe(true);
  });

  it("pins leading zeroes in the pattern", async () => {
    const result = await mine({ ...base, suffix: "0f" });
    expect(endsWith(result.address, "0f")).toBe(true);
  });

  it("satisfies a suffix against a very low quote", async () => {
    // Robinhood's wETH. Ordering against it is what the old prefix miner could not do.
    const low: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
    const result = await mine({ ...base, quote: low, suffix: "ab" });
    expect(endsWith(result.address, "ab")).toBe(true);
    expect(below(result.address, low)).toBe(true);
  });

  it("throws rather than returning a salt that would revert", async () => {
    await expect(
      mine({
        ...base,
        quote: "0x0000000000000000000000000000000000000000",
        suffix: "ab",
        maxAttempts: 4_000,
        batchSize: 1_000,
      }),
    ).rejects.toThrow(/No salt found/);
  });

  it("aborts on signal", async () => {
    const controller = new AbortController();
    const promise = mine({
      ...base,
      // Unsatisfiable, so the only way out is the abort.
      quote: "0x0000000000000000000000000000000000000000",
      suffix: "abcdef",
      batchSize: 1_000,
      signal: controller.signal,
      yieldBetweenBatches: true,
    });
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
  });
});

describe("engine parity", () => {
  /// The whole point: the same request must produce the same salt whichever loop ran it.
  /// Both walk nonces in order from the same start, so the first hit is the same one.
  it("returns an identical salt for identical inputs", async () => {
    for (const suffix of ["ab", "7", "00"]) {
      const opts = {
        deployer: DEPLOYER,
        creator: CREATOR,
        initCodeHash: INIT_CODE_HASH,
        quote: QUOTE,
        suffix,
        yieldBetweenBatches: false,
      };
      const [w, j] = await Promise.all([mineSaltWasm(opts), mineSaltJs(opts)]);
      expect(w.salt).toBe(j.salt);
      expect(w.address).toBe(j.address);
      expect(w.attempts).toBe(j.attempts);
    }
  });

  it("agrees when sharded off a non-zero start", async () => {
    const opts = {
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: QUOTE,
      suffix: "3f",
      startNonce: 500_000n,
      stride: 3n,
      yieldBetweenBatches: false,
    };
    const [w, j] = await Promise.all([mineSaltWasm(opts), mineSaltJs(opts)]);
    expect(w.salt).toBe(j.salt);
    // On its own residue class, which is what makes a worker pool cover the space once.
    expect(((BigInt(w.salt) & ((1n << 96n) - 1n)) - 500_000n) % 3n).toBe(0n);
  });
});

describe("mineSalt", () => {
  it("grinds with no suffix, as every launch has always done", async () => {
    const result = await mineSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: QUOTE,
      yieldBetweenBatches: false,
    });
    expect(below(result.address, QUOTE)).toBe(true);
  });

  it("routes a suffix to WASM and a bare launch to JS", async () => {
    expect(await selectMineEngine({})).toBe("js");
    expect(await selectMineEngine({ suffix: "" })).toBe("js");
    expect(await selectMineEngine({ suffix: "cafe" })).toBe("wasm");
    expect(await selectMineEngine({ suffix: "cafe", engine: "js" })).toBe("js");
  });

  it("honours a forced engine", async () => {
    const opts = {
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: QUOTE,
      suffix: "5",
      yieldBetweenBatches: false,
    };
    const forced = await mineSalt({ ...opts, engine: "js" as const });
    const auto = await mineSalt(opts);
    expect(forced.salt).toBe(auto.salt);
  });

  it("rejects a non-hex suffix before hashing anything", async () => {
    await expect(
      mineSalt({
        deployer: DEPLOYER,
        creator: CREATOR,
        initCodeHash: INIT_CODE_HASH,
        quote: QUOTE,
        suffix: "nope",
      }),
    ).rejects.toThrow(/hex/i);
  });
});

/** Documented difficulty, measured. A regression here is a perf regression. */
describe("throughput", () => {
  it("grinds four nibbles in WASM", async () => {
    const started = Date.now();
    const result = await mineSaltWasm({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      quote: QUOTE,
      suffix: "beef",
      yieldBetweenBatches: false,
    });
    const elapsed = Date.now() - started;
    expect(endsWith(result.address, "beef")).toBe(true);
    // Generous: the mean is 131k attempts, so this is a smoke test for "the loop is not
    // accidentally quadratic", not a benchmark.
    expect(elapsed).toBeLessThan(30_000);
  });
});

describe("randomNonce", () => {
  /// The launch path mines from a random start because the address is a function of
  /// (LaunchLib, salt, initCodeHash(name, symbol)): from a fixed 0, the same creator
  /// relaunching the same name and ticker grinds the identical salt and reverts
  /// `TokenAddressTaken()` in LaunchLib, AFTER the metadata has been pinned at it.
  it("is 62 bits, so a start plus its whole grind stays inside the u64 the WASM counts in", () => {
    for (let i = 0; i < 200; i++) {
      const n = randomNonce();
      expect(n).toBeGreaterThanOrEqual(0n);
      expect(n).toBeLessThan(1n << 62n);
    }
  });

  it("does not repeat", () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 500; i++) seen.add(randomNonce());
    expect(seen.size).toBe(500);
  });

  /// The property that matters: a salt built on it is still creator bound, so the
  /// randomness cannot leak into the high 20 bytes `launch` checks.
  it("leaves the creator binding intact", () => {
    const salt = packSalt(CREATOR, randomNonce());
    expect(saltCreator(salt).toLowerCase()).toBe(CREATOR.toLowerCase());
  });
});
