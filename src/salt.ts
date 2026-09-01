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
