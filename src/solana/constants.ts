import { address, type Address } from "@solana/kit";

/**
 * Solana has no chain id, so Rally uses Envio's HyperSync label ids, which keeps every
 * `Record<number, ...>` in the stack (indexer, manifests, metadata paths) on one key.
 * See docs/SOLANA.md.
 */
export const SOLANA_MAINNET_CHAIN_ID = 7565164;
export const SOLANA_DEVNET_CHAIN_ID = 7565165;

/** CAIP-2 ids, for external boundaries (MCP tools, partner APIs). Internally the number is the key. */
export const SOLANA_CAIP2 = {
  [SOLANA_MAINNET_CHAIN_ID]: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  [SOLANA_DEVNET_CHAIN_ID]: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;

export type SolanaChainId = typeof SOLANA_MAINNET_CHAIN_ID | typeof SOLANA_DEVNET_CHAIN_ID;

export function isSolanaChainId(chainId: number): chainId is SolanaChainId {
  return chainId === SOLANA_MAINNET_CHAIN_ID || chainId === SOLANA_DEVNET_CHAIN_ID;
}

/** `vm` is derived from the id: the two ids above are `svm`, everything else `evm`. */
export function vmOf(chainId: number): "evm" | "svm" {
  return isSolanaChainId(chainId) ? "svm" : "evm";
}

export function caip2Of(chainId: number): string | undefined {
  return isSolanaChainId(chainId) ? SOLANA_CAIP2[chainId] : undefined;
}

export function chainIdOfCaip2(caip2: string): SolanaChainId | undefined {
  if (caip2 === SOLANA_CAIP2[SOLANA_MAINNET_CHAIN_ID]) return SOLANA_MAINNET_CHAIN_ID;
  if (caip2 === SOLANA_CAIP2[SOLANA_DEVNET_CHAIN_ID]) return SOLANA_DEVNET_CHAIN_ID;
  return undefined;
}

/** Launch tokens are 6dp on Solana (a u64 cannot hold 1e9 tokens at 18dp). */
export const LAUNCH_TOKEN_DECIMALS = 6;

/** The Rally Solana protocol program. Same on every cluster until a mainnet key is chosen. */
export const RALLY_SOLANA_PROTOCOL_PROGRAM_ID: Address = address("7mdwZfoJm6iXj3hWsqsbeqExJV6SZ3EYQWnBqGmKGz76");

export const TOKEN_PROGRAM_ADDRESS: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ADDRESS: Address = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS: Address = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ADDRESS: Address = address("11111111111111111111111111111111");
export const MEMO_PROGRAM_ADDRESS: Address = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const RENT_SYSVAR_ADDRESS: Address = address("SysvarRent111111111111111111111111111111111");
export const CLOCK_SYSVAR_ADDRESS: Address = address("SysvarC1ock11111111111111111111111111111111");

/** Wrapped SOL, the native-asset quote (9dp). */
export const WSOL_MINT: Address = address("So11111111111111111111111111111111111111112");

/**
 * Raydium CLMM on devnet. This is the program id the shipped IDL pins (the program is built
 * with `--features devnet`), so it is the default when no deployment overrides it.
 */
export const RAYDIUM_CLMM_DEVNET: Address = address("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
/** Devnet's tick-spacing-60 fee tier (0.25%). */
export const RAYDIUM_AMM_CONFIG_60_DEVNET: Address = address("CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu");

export const TICK_SPACING = 60;
export const TICK_ARRAY_SIZE = 60;
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

/** `open_pool` rent advance default: the creator funds Raydium's account rent, the surplus returns. */
export const DEFAULT_RENT_BUDGET_LAMPORTS = 1_500_000_000n;
/** Raydium pool seed for `open_pool`; any unused value works. */
export const DEFAULT_POOL_SEED_INDEX = 1;
