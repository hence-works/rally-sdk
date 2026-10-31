import type { Address } from "@solana/kit";

/** One baked Solana deployment (`packages/rally-solana/deployments/<chainId>.json`). */
export interface SolanaDeployment {
  vm: "svm";
  chainId: number;
  caip2: string;
  /** The rally_launch program. */
  rallyLaunch: string;
  /** The `Config` PDA. */
  config: string;
  /** The protocol address lookup table (what brings `open_pool` under 1232 bytes). */
  lookupTable: string;
  /** The Raydium CLMM program this cluster's pools live under. */
  raydiumClmm: string;
  /** The Raydium fee tier (tick spacing 60) launches open in. */
  raydiumAmmConfig: string;
  /**
   * Allowlisted quotes, as the deploy script recorded them (keys camelCased). The row shape
   * belongs to the deploy script, so only the fields every row is expected to carry are
   * typed; read the rest defensively.
   */
  quotes: Array<{ mint?: string; symbol?: string; decimals?: number } & Record<string, unknown>>;
}

/** Something that has an address: a bare base58 key, or a kit `TransactionSigner`. */
export type AddressOrSigner = Address | { readonly address: Address };

export type Phase = "Created" | "Curve" | "Breakout";

export interface FeeConfig {
  creatorBps: number;
  dividendBps: number;
  buybackBps: number;
  lpSupportBps: number;
}

export interface CurveSegment {
  startBps: number;
  endBps: number;
  numPositions: number;
  sharesBps: number;
  anchorAtFar: boolean;
}

export interface PositionInfo {
  nftMint: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeNftMint: Address;
}

/** Decoded `Launch` account (PDA `["launch", mint]`). Amounts are bigint, never number. */
export interface LaunchAccount {
  bump: number;
  authorityBump: number;
  phase: Phase;
  curvePreset: number;
  mint: Address;
  creator: Address;
  quoteMint: Address;
  /** Raydium pool state; the system program id (all zero) until `open_pool`. */
  pool: Address;
  ammConfig: Address;
  createdAt: bigint;
  launchedAt: bigint;
  brokeOutAt: bigint;
  tickLower: number;
  tickUpper: number;
  /** `B`, in the quote's base units. */
  gradThreshold: bigint;
  totalSupply: bigint;
  curveSupply: bigint;
  tailSupply: bigint;
  firstBuyTokens: bigint;
  feeConfig: FeeConfig;
  breakoutFeeConfig: FeeConfig;
  breakoutSplitArmed: boolean;
  schedule: {
    curveFeeStartBps: number;
    curveFeeEndBps: number;
    curveFeeDecay: number;
    platformBps: number;
    creatorCapBps: number;
    breakoutCreatorCapBps: number;
  };
  buckets: { creator: bigint; dividend: bigint; buyback: bigint; lpSupport: bigint; platform: bigint };
  numPositions: number;
  /** Always 6 slots; only the first `numPositions` are in use. */
  positions: PositionInfo[];
  support: PositionInfo;
  supportTokenReserve: bigint;
  flushSlot: bigint;
  flushedInSlot: bigint;
  dividendEpoch: bigint;
  dividendReserved: bigint;
  supportNonce: number;
}

/** Decoded `QuoteConfig` account (PDA `["quote", mint]`). */
export interface QuoteConfigAccount {
  bump: number;
  vaultBump: number;
  mint: Address;
  vault: Address;
  tokenProgram: Address;
  decimals: number;
  enabled: boolean;
  /** `B`, quote base units. */
  gradThreshold: bigint;
  /** `F`, quote base units. */
  launchFee: bigint;
  ammConfig: Address;
  dynamicFeeConfig: Address;
  treasuryOwed: bigint;
  referralOwed: bigint;
}

/** Decoded `Config` singleton (PDA `["config"]`). `params` and `pending` are the governed table. */
export interface ConfigAccount {
  bump: number;
  governance: Address;
  pendingGovernance: Address;
  treasury: Address;
  dividendKeeper: Address;
  paused: boolean;
  creatorClaimEscrow: boolean;
  customCurvesAllowed: boolean;
  raydiumLockEnabled: boolean;
  params: bigint[];
  pending: Array<{ value: bigint; eta: bigint }>;
  defaultFeeConfig: FeeConfig;
  defaultBreakoutFeeConfig: FeeConfig;
  launchCount: bigint;
}

export interface ReferralAccountData {
  bump: number;
  referrer: Address;
  quoteMint: Address;
  owed: bigint;
  earned: bigint;
}
