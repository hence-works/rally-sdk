/**
 * Creator-bound launch salts.
 *
 * `RallyFactory.launch(name, symbol, metadataURI, salt, …)` deploys the ERC-20 with
 * CREATE2, and the salt is mined off-chain so the token lands at an address that sorts
 * below its quote (I-7). Two properties follow, and both matter to an integrator:
 *
 *   - the address is a pure function of the salt, so it is knowable *before* the
 *     launch transaction — which is what lets metadata be pinned at
 *     `/<chainId>/<token>.json` up front (an unresolvable metadataURI is permanent); and
 *   - the salt's high 20 bytes must equal `msg.sender`, so the address commits to its
 *     creator and a mempool watcher cannot replay public calldata to steal it.
 */
import { getCreate2Address, numberToHex, type Address, type Hex } from "viem";

const NONCE_MASK = (1n << 96n) - 1n;

/**
 * Build a creator-bound salt: high 20 bytes `creator`, low 12 bytes `nonce`. Mirrors
 * `RallyFactory.packSalt`. `launch` rejects any salt whose high bytes aren't the
 * sender, so mining fixes these high bytes and grinds only the nonce.
 */
export function packSalt(creator: Address, nonce: bigint): Hex {
  return numberToHex((BigInt(creator) << 96n) | (nonce & NONCE_MASK), { size: 32 });
}

/** The creator a salt is bound to — mirrors `RallyFactory.saltCreator`. */
export function saltCreator(salt: Hex): Address {
  return numberToHex(BigInt(salt) >> 96n, { size: 20 });
}

/** The CREATE2 address for a salt, given the token init-code hash (pure, local). */
export function computeTokenAddress(
  deployer: Address,
  salt: Hex,
  initCodeHash: Hex,
): Address {
  return getCreate2Address({ from: deployer, salt, bytecodeHash: initCodeHash });
}

/**
 * A random 62-bit mining start.
 *
 * The nonce a grind begins at has to differ per launch, and defaulting it to 0 is a
 * real failure rather than an untidiness: a token's address is
 * `CREATE2(LaunchLib, salt, initCodeHash(name, symbol))`, so the same creator mining
 * the same name and symbol from nonce 0 finds the SAME first qualifying salt every
 * time, and the second launch reverts `TokenAddressTaken()` in `LaunchLib.mineAndDeploy`.
 * That revert lands AFTER the metadata has been pinned at the address, and a pinned
 * blob at a dead address is not recoverable.
 *
 * 62 bits, not 64: the WASM engine counts in the salt's low 8 bytes, so the start plus
 * the whole grind has to stay inside a u64, and this leaves 2 bits of headroom (about
 * 4.6e18 attempts) above any start. Two independent runs land within one grind of each
 * other with probability around 2^-37, which is the point of the width.
 */
export function randomNonce(): bigint {
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  const bytes = new Uint8Array(8);
  if (typeof webcrypto?.getRandomValues === "function") {
    webcrypto.getRandomValues(bytes);
  } else {
    // No WebCrypto (an exotic runtime; Node 20+ and every browser have it). Weaker
    // entropy is still enormously better than a fixed 0 here, so degrade rather than
    // throw and take a launch down over it.
    for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n & ((1n << 62n) - 1n);
}
