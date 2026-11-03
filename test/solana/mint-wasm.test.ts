import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { addressBytes } from "../../src/solana/address";
import { grindMintWithWasmFallback } from "../../src/solana/mint";
import { instantiateMintWasm, mineMintSuffixWasm, type MintWasmExports } from "../../src/solana/mint-wasm";
import { addr } from "./fixtures";

async function fixtureExports(options: { hitAfter?: number; seed?: Uint8Array } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const masterPtr = 0;
  const quotePtr = 32;
  const suffixPtr = 64;
  const resultPtr = 128;
  const seed = options.seed ?? new Uint8Array(32).fill(7);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const result = new Uint8Array(memory.buffer, resultPtr, 64);
  result.set(seed, 0);
  result.set(addressBytes(signer.address), 32);

  let attempts = 0;
  let lastAttempts = 0;
  let configuredLength = -1;
  let foundNonce = 0n;
  const calls: Array<{ start: bigint; stride: bigint; budget: number }> = [];
  const hitAfter = options.hitAfter ?? 1;
  const exports: MintWasmExports = {
    memory,
    master_seed_ptr: () => masterPtr,
    quote_ptr: () => quotePtr,
    suffix_ptr: () => suffixPtr,
    result_ptr: () => resultPtr,
    configure: (length) => {
      configuredLength = length;
      return 0;
    },
    mine: (start, stride, budget) => {
      calls.push({ start, stride, budget });
      const spent = Math.min(budget, hitAfter - attempts);
      attempts += spent;
      lastAttempts = spent;
      if (attempts >= hitAfter) foundNonce = start + BigInt(spent - 1) * stride;
      return attempts >= hitAfter ? 1 : 0;
    },
    attempts: () => lastAttempts,
    found_nonce: () => foundNonce,
    clear: () => undefined,
  };
  return { exports, calls, signer, configuredLength: () => configuredLength };
}

describe("Solana mint WASM adapter", () => {
  it("falls back to the WebCrypto keypair loop when WASM cannot instantiate", async () => {
    await expect(
      grindMintWithWasmFallback(
        addr(0),
        {
          suffix: "7",
          maxAttempts: 3,
          masterSeed: new Uint8Array(32).fill(1),
        },
        async () => {
          throw new Error("WebAssembly unavailable");
        },
      ),
    ).rejects.toMatchObject({ code: "MINING_FAILED", details: { attempts: 3, suffix: "7" } });

    await expect(
      grindMintWithWasmFallback(
        addr(0xff),
        {
          suffix: "7",
          masterSeed: new Uint8Array(32).fill(1),
          maxAttempts: 1,
          stride: 1n << 64n,
        },
        async () => {
          throw new Error("WebAssembly unavailable");
        },
      ),
    ).rejects.toMatchObject({ code: "MINING_FAILED" });
  });

  it("matches the Rust SHA-256/ed25519 vector", async () => {
    const masterSeed = new Uint8Array(32).fill(7);
    const result = await mineMintSuffixWasm(addr(0xff), "mVd6", {
      masterSeed,
      maxAttempts: 1,
      instantiate: instantiateMintWasm,
    });
    expect(Array.from(result.seed, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      "7c87c3b8f2da19fe841e74b9bbcbd5109643f0ff2214601b5129210de8082bda",
    );
    expect(result.address).toBe("WGHbPfZp1YzNQaFdQvDc9PQgTKK2K2oT6K2gTVBmVd6");
    expect(result.nonce).toBe(0n);
    expect(result.attempts).toBe(1);

    const fallback = await grindMintWithWasmFallback(
      addr(0xff),
      { suffix: "mVd6", masterSeed, maxAttempts: 1 },
      async () => {
        throw new Error("force WebCrypto parity path");
      },
    );
    expect(fallback.seed).toEqual(result.seed);
    expect(fallback.address).toBe(result.address);
    expect(fallback.nonce).toBe(result.nonce);
  });

  it.each([1n << 63n, (1n << 64n) - 1n])("normalizes the real WASM i64 nonce %s as unsigned", async (nonce) => {
    const masterSeed = new Uint8Array(32).fill(9);
    const input = new Uint8Array(40);
    input.set(masterSeed);
    new DataView(input.buffer).setBigUint64(32, nonce, true);
    const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    const expected = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const suffix = expected.address.slice(-5);

    const result = await mineMintSuffixWasm(addr(0xff), suffix, {
      masterSeed,
      startNonce: nonce,
      maxAttempts: 1,
      instantiate: instantiateMintWasm,
    });
    expect(result.address).toBe(expected.address);
    expect(result.nonce).toBe(nonce);
  });

  it("copies inputs, reconstructs the signer, and reports the winning nonce", async () => {
    const fixture = await fixtureExports();
    const masterSeed = new Uint8Array(32).map((_, i) => i);
    const quote = addr(0xff);
    const suffix = fixture.signer.address.slice(-1);
    const result = await mineMintSuffixWasm(quote, suffix, {
      masterSeed,
      maxAttempts: 10,
      instantiate: async () => fixture.exports,
    });

    expect(new Uint8Array(fixture.exports.memory.buffer, 0, 32)).toEqual(masterSeed);
    expect(new Uint8Array(fixture.exports.memory.buffer, 32, 32)).toEqual(addressBytes(quote));
    expect(new TextDecoder().decode(new Uint8Array(fixture.exports.memory.buffer, 64, 1))).toBe(suffix);
    expect(fixture.configuredLength()).toBe(1);
    expect(result.address).toBe(fixture.signer.address);
    expect(result.seed).toEqual(new Uint8Array(32).fill(7));
    expect(result.attempts).toBe(1);
    expect(result.nonce).toBe(0n);
  });

  it("uses disjoint deterministic shards and chunks progress", async () => {
    const fixture = await fixtureExports({ hitAfter: 9 });
    const progress: number[] = [];
    await mineMintSuffixWasm(addr(0xff), fixture.signer.address.slice(-1), {
      masterSeed: new Uint8Array(32),
      startNonce: 3n,
      stride: 8n,
      chunkSize: 4,
      maxAttempts: 12,
      onProgress: (attempts) => progress.push(attempts),
      instantiate: async () => fixture.exports,
    });

    expect(fixture.calls).toEqual([
      { start: 3n, stride: 8n, budget: 4 },
      { start: 35n, stride: 8n, budget: 4 },
      { start: 67n, stride: 8n, budget: 4 },
    ]);
    expect(progress).toEqual([4, 8, 9]);
  });

  it("honors cancellation and the exact maximum attempt budget", async () => {
    const fixture = await fixtureExports({ hitAfter: 100 });
    const controller = new AbortController();
    const progress: number[] = [];
    await expect(
      mineMintSuffixWasm(addr(0xff), fixture.signer.address.slice(-1), {
        masterSeed: new Uint8Array(32),
        chunkSize: 4,
        maxAttempts: 10,
        signal: controller.signal,
        onProgress: (attempts) => {
          progress.push(attempts);
          controller.abort();
        },
        instantiate: async () => fixture.exports,
      }),
    ).rejects.toMatchObject({ code: "MINING_FAILED", details: { attempts: 4 } });
    expect(fixture.calls).toHaveLength(1);

    const exhausted = await fixtureExports({ hitAfter: 100 });
    await expect(
      mineMintSuffixWasm(addr(0xff), exhausted.signer.address.slice(-1), {
        masterSeed: new Uint8Array(32),
        chunkSize: 4,
        maxAttempts: 10,
        instantiate: async () => exhausted.exports,
      }),
    ).rejects.toMatchObject({ code: "MINING_FAILED", details: { attempts: 10 } });
    expect(exhausted.calls.map((call) => call.budget)).toEqual([4, 4, 2]);
  });

  it("does not return a winner when progress handling cancels it", async () => {
    const fixture = await fixtureExports();
    const controller = new AbortController();
    await expect(
      mineMintSuffixWasm(addr(0xff), fixture.signer.address.slice(-1), {
        masterSeed: new Uint8Array(32).fill(1),
        maxAttempts: 1,
        signal: controller.signal,
        onProgress: () => controller.abort(),
        instantiate: async () => fixture.exports,
      }),
    ).rejects.toMatchObject({ code: "MINING_FAILED", details: { attempts: 1 } });
  });

  it("rejects a result whose public key does not match its seed", async () => {
    const fixture = await fixtureExports();
    new Uint8Array(fixture.exports.memory.buffer, 128 + 32, 32).fill(0);
    await expect(
      mineMintSuffixWasm(addr(0xff), fixture.signer.address.slice(-1), {
        masterSeed: new Uint8Array(32),
        maxAttempts: 1,
        instantiate: async () => fixture.exports,
      }),
    ).rejects.toMatchObject({ code: "MINING_FAILED" });
  });
});
