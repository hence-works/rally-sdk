/**
 * @rally-fun/sdk/solana: launch and trade Rally coins on Solana (the `rally_launch`
 * Anchor program over Raydium CLMM).
 *
 *   import { grindMint, prepareCreateLaunch, prepareOpenPool, WSOL_MINT } from "@rally-fun/sdk/solana";
 *
 *   const mint = await grindMint(WSOL_MINT);
 *   const create = await prepareCreateLaunch({ chainId: 7565165, rpc, creator, mint: mint.signer, ... });
 *   const open = await prepareOpenPool({ chainId: 7565165, rpc, creator, mint: mint.address, ... });
 *   // Two transactions: send them as a Jito bundle if you can.
 *
 * Needs the optional peer `@solana/kit`. Every write is a `prepare*` returning unsigned
 * kit instructions; nothing here signs or sends. Amounts are bigint base units end to end.
 */

export * from "./constants";
export * from "./types";
export { normalizeAddress, normalizeAddressForChain, normalizeSolanaAddress, sortsBelow } from "./address";
export { rallyPdas, raydiumPdas, findAssociatedTokenAddress, tickArrayStart } from "./pda";
export { grindMint } from "./mint";
export type { GrindMintOptions, GroundMint } from "./mint";
export { priceScale, priceWadFromSqrtPriceX64 } from "./price";
export {
  decodeConfig,
  decodeLaunch,
  decodePoolSlot0,
  decodeQuoteConfig,
  decodeReferral,
  fetchClusterTime,
  fetchConfig,
  fetchLaunch,
  fetchLaunchPriceWad,
  fetchPoolSlot0,
  fetchQuoteConfig,
  fetchReferral,
} from "./accounts";
export type { PoolSlot0, ReadOptions, SolanaRpc } from "./accounts";
export {
  buildRallyInstruction,
  createAtaIdempotentInstruction,
  prepareBuy,
  prepareClaimCreatorFees,
  prepareClaimReferralFees,
  prepareCollectFees,
  prepareCreateLaunch,
  prepareOpenPool,
  prepareRegisterReferrer,
  prepareSell,
} from "./instructions";
export type {
  PrepareClaimCreatorFeesParams,
  PrepareClaimReferralFeesParams,
  PrepareCollectFeesParams,
  PrepareCreateLaunchParams,
  PrepareOpenPoolParams,
  PrepareReferralParams,
  PrepareSwapParams,
  PreparedSolanaTransaction,
  SolanaTarget,
} from "./instructions";
export { SOLANA_DEPLOYMENTS } from "./deployments.generated";
export { getSolanaDeployment } from "./deployments";
export { RALLY_LAUNCH_IDL } from "./idl.generated";
export { RallyError, isRallyError } from "../errors";
export type { RallyErrorCode } from "../errors";
