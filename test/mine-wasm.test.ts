/**
 * The WASM engine is the default, so it carries the same burden the JS loop does: a
 * wrong salt means a launch that reverts `VanityMismatch` *after* the metadata has
 * been pinned. These tests pin three things — WASM agrees with viem's CREATE2, WASM
 * agrees with the JS loop salt-for-salt, and the fallback actually falls back.
 */
import { describe, expect, it, vi } from "vitest";
import { getCreate2Address, keccak256, toHex, type Address } from "viem";
import { mineVanitySalt } from "../src/mine";
import { mineVanitySaltJs } from "../src/mine-core";
import { isWasmMinerAvailable, mineVanitySaltWasm } from "../src/mine-wasm";
import { matchesVanity, saltCreator, type Vanity } from "../src/salt";

const CREATOR: Address = "0x1111111111111111111111111111111111111111";
const DEPLOYER: Address = "0xA70e6e3D871687D1ddf8a9D493e33A67Ac066653";
const INIT_CODE_HASH = keccak256(toHex("RallyToken"));
const LFGO: Vanity = { prefixLen: 4, prefixBits: 0x1f60n, suffixLen: 0, suffixBits: 0n };

const base = {
  deployer: DEPLOYER,
  creator: CREATOR,
  initCodeHash: INIT_CODE_HASH,
  yieldBetweenBatches: false,
} as const;

describe("WASM miner", () => {
  it("is available in this runtime", async () => {
    expect(await isWasmMinerAvailable()).toBe(true);
  });

  it("produces a salt whose CREATE2 address viem agrees with", async () => {
    const result = await mineVanitySaltWasm({ ...base, vanity: LFGO });
    expect(result.address).toBe(
      getCreate2Address({ from: DEPLOYER, salt: result.salt, bytecodeHash: INIT_CODE_HASH }),
    );
    expect(matchesVanity(result.address, LFGO)).toBe(true);
    expect(saltCreator(result.salt).toLowerCase()).toBe(CREATOR.toLowerCase());
  });

  it("finds the same first salt as the JS loop", async () => {
    // Both scan nonces from 0 upwards by 1, so the FIRST hit is a property of the
    // curve of keccak digests, not of the implementation. Divergence here means one
    // engine is hashing a different preimage.
    const [wasm, js] = await Promise.all([
      mineVanitySaltWasm({ ...base, vanity: LFGO }),
      mineVanitySaltJs({ ...base, vanity: LFGO }),
    ]);
    expect(wasm.salt).toBe(js.salt);
    expect(wasm.address).toBe(js.address);
    expect(wasm.attempts).toBe(js.attempts);
  });

  it("agrees with the JS loop on a prefix+suffix pattern", async () => {
    const vanity: Vanity = { prefixLen: 2, prefixBits: 0xban, suffixLen: 2, suffixBits: 0x5en };
    const [wasm, js] = await Promise.all([
      mineVanitySaltWasm({ ...base, vanity }),
      mineVanitySaltJs({ ...base, vanity }),
    ]);
    expect(wasm.salt).toBe(js.salt);
    expect(matchesVanity(wasm.address, vanity)).toBe(true);
  });

  it("agrees with the JS loop when sharded", async () => {
    const shard = { startNonce: 3n, stride: 7n };
    const [wasm, js] = await Promise.all([
      mineVanitySaltWasm({ ...base, vanity: LFGO, ...shard }),
      mineVanitySaltJs({ ...base, vanity: LFGO, ...shard }),
    ]);
    expect(wasm.salt).toBe(js.salt);
    expect(wasm.attempts).toBe(js.attempts);
  });

  it("skips the module entirely when no pattern is pinned", async () => {
    const result = await mineVanitySaltWasm({
      ...base,
      vanity: { prefixLen: 0, prefixBits: 0n, suffixLen: 0, suffixBits: 0n },
    });
    expect(result.attempts).toBe(0);
  });

  it("refuses a pattern wider than its u64 layout instead of mis-mining", async () => {
    await expect(
      mineVanitySaltWasm({
        ...base,
        vanity: { prefixLen: 17, prefixBits: 1n, suffixLen: 0, suffixBits: 0n },
      }),
    ).rejects.toThrow(/16 nibbles/);
  });

  it("stops at maxAttempts rather than overrunning the budget", async () => {
    await expect(
      mineVanitySaltWasm({
        ...base,
        vanity: { prefixLen: 10, prefixBits: 0xdeadbeef12n, suffixLen: 0, suffixBits: 0n },
        maxAttempts: 50_000,
        batchSize: 10_000,
      }),
    ).rejects.toThrow(/No vanity salt found in 50000 attempts/);
  });
});

describe("engine selection", () => {
  it("uses WASM by default", async () => {
    const result = await mineVanitySalt({ ...base, vanity: LFGO });
    expect(result.engine).toBe("wasm");
  });

  it("uses the JS loop when forced", async () => {
    const result = await mineVanitySalt({ ...base, vanity: LFGO, engine: "js" });
    expect(result.engine).toBe("js");
  });

  /**
   * The module is instantiated once per process and memoised, so hiding `WebAssembly`
   * after another test has already loaded it proves nothing. Reset the module registry
   * and re-import so the loader really runs against the crippled runtime.
   */
  async function withoutWebAssembly<T>(fn: (mine: typeof mineVanitySalt) => Promise<T>): Promise<T> {
    const original = globalThis.WebAssembly;
    vi.resetModules();
    // @ts-expect-error — deliberately removing a global for this test
    delete globalThis.WebAssembly;
    try {
      const fresh = (await import("../src/mine")) as typeof import("../src/mine");
      return await fn(fresh.mineVanitySalt);
    } finally {
      globalThis.WebAssembly = original;
      vi.resetModules();
    }
  }

  it("falls back to JS when WASM can't be instantiated", async () => {
    await withoutWebAssembly(async (mine) => {
      const result = await mine({ ...base, vanity: LFGO });
      expect(result.engine).toBe("js");
      expect(matchesVanity(result.address, LFGO)).toBe(true);
    });
  });

  it("throws instead of falling back when WASM is demanded", async () => {
    await withoutWebAssembly(async (mine) => {
      await expect(mine({ ...base, vanity: LFGO, engine: "wasm" })).rejects.toThrow(
        /WebAssembly is unavailable/,
      );
    });
  });

  it("does not retry in JS after an abort — a cancellation is an answer", async () => {
    const controller = new AbortController();
    const spy = vi.fn();
    const promise = mineVanitySalt({
      ...base,
      vanity: { prefixLen: 12, prefixBits: 0xdeadbeef1234n, suffixLen: 0, suffixBits: 0n },
      batchSize: 1_000,
      onProgress: spy,
      signal: controller.signal,
      yieldBetweenBatches: true,
    });
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
  });
});
