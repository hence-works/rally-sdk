import { createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner } from "@solana/kit";
import { RallyError } from "../errors";
import { addressBytes } from "./address";
import { SOLANA_MINT_WASM_BASE64 } from "./mint-wasm-bin";

const MAX_U64 = (1n << 64n) - 1n;

export interface MintWasmExports {
  memory: WebAssembly.Memory;
  master_seed_ptr(): number;
  suffix_ptr(): number;
  configure(suffixLength: number): number | void;
  mine(start: bigint, stride: bigint, budget: number): number;
  attempts(): number;
  result_ptr(): number;
  found_nonce(): bigint;
  clear(): void;
}

export interface MineMintSuffixWasmOptions {
  masterSeed: Uint8Array;
  maxAttempts: number;
  startNonce?: bigint;
  stride?: bigint;
  chunkSize?: number;
  extractable?: boolean;
  signal?: AbortSignal;
  onProgress?: (attempts: number) => void;
  instantiate: () => Promise<MintWasmExports>;
}

export interface WasmGroundMint {
  signer: KeyPairSigner;
  address: Address;
  seed: Uint8Array;
  attempts: number;
  nonce: bigint;
}

function decodeBase64(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const nodeBuffer = (globalThis as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(base64, "base64"));
  throw new RallyError("UNSUPPORTED", "No base64 decoder is available for the Solana vanity miner");
}

/** Instantiate a fresh module because each active grind mutates the module's linear memory. */
export async function instantiateMintWasm(): Promise<MintWasmExports> {
  if (typeof WebAssembly === "undefined" || typeof WebAssembly.instantiate !== "function") {
    throw new RallyError("UNSUPPORTED", "WebAssembly is unavailable in this runtime");
  }
  const source = (await WebAssembly.instantiate(
    decodeBase64(SOLANA_MINT_WASM_BASE64) as unknown as BufferSource,
    {},
  )) as WebAssembly.WebAssemblyInstantiatedSource;
  return source.instance.exports as unknown as MintWasmExports;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  return different === 0;
}

function cancelled(attempts: number): RallyError {
  return new RallyError("MINING_FAILED", "Mint grinding was cancelled", { details: { attempts } });
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Internal adapter for the generated Solana ed25519 vanity-miner module. */
export async function mineMintSuffixWasm(
  suffix: string,
  options: MineMintSuffixWasmOptions,
): Promise<WasmGroundMint> {
  if (options.masterSeed.length !== 32) {
    throw new RallyError("MINING_FAILED", "WASM master seed must be 32 bytes");
  }
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RallyError("MINING_FAILED", "maxAttempts must be a positive safe integer");
  }
  const startNonce = options.startNonce ?? 0n;
  const stride = options.stride ?? 1n;
  if (startNonce < 0n || startNonce > MAX_U64) {
    throw new RallyError("MINING_FAILED", "startNonce must fit in an unsigned 64-bit integer");
  }
  if (stride < 1n || stride > MAX_U64) {
    throw new RallyError("MINING_FAILED", "stride must fit in a non-zero unsigned 64-bit integer");
  }
  if (startNonce + BigInt(options.maxAttempts - 1) * stride > MAX_U64) {
    throw new RallyError("MINING_FAILED", "The requested Solana vanity nonce range exceeds 64 bits");
  }
  const chunkSize = options.chunkSize ?? 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 4096) {
    throw new RallyError("MINING_FAILED", "chunkSize must be an integer between 1 and 4096");
  }
  if (options.signal?.aborted) throw cancelled(0);

  let wasm: MintWasmExports | undefined;
  try {
    wasm = await options.instantiate();
    wasm.clear();
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(options.masterSeed, wasm.master_seed_ptr());
    memory.set(new TextEncoder().encode(suffix), wasm.suffix_ptr());
    const configured = wasm.configure(suffix.length);
    if (typeof configured === "number" && configured < 0) {
      throw new RallyError("MINING_FAILED", `Solana vanity miner rejected its configuration (${configured})`);
    }

    let completed = 0;
    while (completed < options.maxAttempts) {
      if (options.signal?.aborted) throw cancelled(completed);
      const hostBudget = Math.min(chunkSize, options.maxAttempts - completed);
      let hostCompleted = 0;
      let status = 0;
      while (hostCompleted < hostBudget) {
        const budget = Math.min(4096, hostBudget - hostCompleted);
        const chunkStart = startNonce + BigInt(completed) * stride;
        status = wasm.mine(chunkStart, stride, budget);
        if (status < 0) throw new RallyError("MINING_FAILED", `Solana vanity miner failed (${status})`);

        const reported = wasm.attempts();
        if (!Number.isSafeInteger(reported) || reported < 1 || reported > budget) {
          throw new RallyError("MINING_FAILED", "Solana vanity miner returned an invalid attempt count");
        }
        completed += reported;
        hostCompleted += reported;
        if (status !== 0) break;
        if (reported !== budget) throw new RallyError("MINING_FAILED", "Solana vanity miner made incomplete progress");
      }
      options.onProgress?.(completed);
      if (options.signal?.aborted) throw cancelled(completed);

      if (status === 1) {
        const bytes = new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), 64);
        const seed = bytes.slice(0, 32);
        const returnedPublicKey = bytes.slice(32, 64);
        try {
          const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, options.extractable ?? false);
          if (options.signal?.aborted) throw cancelled(completed);
          const reconstructedPublicKey = addressBytes(signer.address);
          if (
            !equalBytes(returnedPublicKey, reconstructedPublicKey) ||
            !signer.address.endsWith(suffix)
          ) {
            throw new RallyError("MINING_FAILED", "Solana vanity miner returned an invalid keypair");
          }
          // WebAssembly i64 values cross the JS boundary as signed BigInts even though the Rust
          // nonce is a u64. Normalize the upper half before validating the worker shard.
          const nonce = BigInt.asUintN(64, wasm.found_nonce());
          const firstPossible = startNonce;
          const lastPossible = startNonce + BigInt(completed - 1) * stride;
          if (nonce < firstPossible || nonce > lastPossible || (nonce - startNonce) % stride !== 0n) {
            throw new RallyError("MINING_FAILED", "Solana vanity miner returned an invalid nonce");
          }
          return {
            signer,
            address: signer.address,
            seed,
            attempts: completed,
            nonce,
          };
        } catch (error) {
          seed.fill(0);
          throw error;
        }
      }
      if (status !== 0) throw new RallyError("MINING_FAILED", `Solana vanity miner returned an unknown status (${status})`);
      if (completed === options.maxAttempts) break;
      await yieldToHost();
    }

    throw new RallyError(
      "MINING_FAILED",
      `No mint ending in "${suffix}" found in ${options.maxAttempts} attempts`,
      { details: { attempts: options.maxAttempts, suffix } },
    );
  } finally {
    wasm?.clear();
  }
}
