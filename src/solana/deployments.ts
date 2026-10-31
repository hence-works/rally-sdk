import { RallyError } from "../errors";
import { SOLANA_DEPLOYMENTS } from "./deployments.generated";
import type { SolanaDeployment } from "./types";

/**
 * The baked deployment for a Solana chain id. Throws `MISSING_ADDRESS` when the program has
 * not been deployed to that cluster (nothing is invented), in which case pass `programId`,
 * `raydiumClmm` and `lookupTable` to the `prepare*` functions directly.
 */
export function getSolanaDeployment(chainId: number): SolanaDeployment {
  const d = SOLANA_DEPLOYMENTS[chainId];
  if (!d) {
    throw new RallyError("MISSING_ADDRESS", `No baked Rally deployment for Solana chain ${chainId}`, {
      details: { chainId },
    });
  }
  return d;
}
