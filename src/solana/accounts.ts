import { getBase64Encoder, type Address, type GetAccountInfoApi, type Rpc } from "@solana/kit";
import { RallyError } from "../errors";
import { decodeAccount } from "./codec";
import { CLOCK_SYSVAR_ADDRESS, RALLY_SOLANA_PROTOCOL_PROGRAM_ID, RAYDIUM_CLMM_DEVNET } from "./constants";
import { rallyPdas } from "./pda";
import { priceWadFromSqrtPriceX64 } from "./price";
import type {
  ConfigAccount,
  LaunchAccount,
  QuoteConfigAccount,
  ReferralAccountData,
} from "./types";

/** The slice of the kit RPC the read helpers use. Any `createSolanaRpc(...)` satisfies it. */
export type SolanaRpc = Rpc<GetAccountInfoApi>;

export const decodeLaunch = (data: Uint8Array) => decodeAccount<LaunchAccount>("Launch", data);
export const decodeQuoteConfig = (data: Uint8Array) => decodeAccount<QuoteConfigAccount>("QuoteConfig", data);
export const decodeConfig = (data: Uint8Array) => decodeAccount<ConfigAccount>("Config", data);
export const decodeReferral = (data: Uint8Array) => decodeAccount<ReferralAccountData>("ReferralAccount", data);

interface RawAccount {
  data: Uint8Array;
  owner: Address;
}

async function getAccount(rpc: SolanaRpc, addr: Address): Promise<RawAccount | null> {
  const res = await rpc.getAccountInfo(addr, { encoding: "base64" }).send();
  if (!res.value) return null;
  const [b64] = res.value.data;
  return { data: new Uint8Array(getBase64Encoder().encode(b64)), owner: res.value.owner };
}

/** Owner check: an account at the right address but owned by another program is not ours to trust. */
function requireOwner(acc: RawAccount, owner: Address, what: string, at: Address): void {
  if (acc.owner !== owner) {
    throw new RallyError("INVALID_ACCOUNT_DATA", `${what} ${at} is owned by ${acc.owner}, expected ${owner}`, {
      details: { address: at, owner: acc.owner, expected: owner },
    });
  }
}

export interface ReadOptions {
  programId?: Address;
}

/** Fetch a launch by its MINT. Throws `LAUNCH_NOT_FOUND` when no such launch exists. */
export async function fetchLaunch(rpc: SolanaRpc, mint: Address, opts: ReadOptions = {}): Promise<LaunchAccount> {
  const programId = opts.programId ?? RALLY_SOLANA_PROTOCOL_PROGRAM_ID;
  const at = await rallyPdas(programId).launch(mint);
  const acc = await getAccount(rpc, at);
  if (!acc) throw new RallyError("LAUNCH_NOT_FOUND", `No launch for mint ${mint}`, { details: { mint } });
  requireOwner(acc, programId, "Launch account", at);
  return decodeLaunch(acc.data);
}

/** Fetch a quote's `QuoteConfig`: its decimals, `B`, launch fee, token program and Raydium tier. */
export async function fetchQuoteConfig(
  rpc: SolanaRpc,
  quoteMint: Address,
  opts: ReadOptions = {},
): Promise<QuoteConfigAccount> {
  const programId = opts.programId ?? RALLY_SOLANA_PROTOCOL_PROGRAM_ID;
  const at = await rallyPdas(programId).quoteConfig(quoteMint);
  const acc = await getAccount(rpc, at);
  if (!acc) {
    throw new RallyError("QUOTE_NOT_ALLOWED", `${quoteMint} is not a configured quote`, { details: { quoteMint } });
  }
  requireOwner(acc, programId, "QuoteConfig account", at);
  return decodeQuoteConfig(acc.data);
}

export async function fetchConfig(rpc: SolanaRpc, opts: ReadOptions = {}): Promise<ConfigAccount> {
  const programId = opts.programId ?? RALLY_SOLANA_PROTOCOL_PROGRAM_ID;
  const at = await rallyPdas(programId).config();
  const acc = await getAccount(rpc, at);
  if (!acc) throw new RallyError("MISSING_ADDRESS", "The Config account does not exist (program not initialized)");
  requireOwner(acc, programId, "Config account", at);
  return decodeConfig(acc.data);
}

/** A referrer's registered balance for one quote, or null when they never registered. */
export async function fetchReferral(
  rpc: SolanaRpc,
  quoteMint: Address,
  referrer: Address,
  opts: ReadOptions = {},
): Promise<ReferralAccountData | null> {
  const programId = opts.programId ?? RALLY_SOLANA_PROTOCOL_PROGRAM_ID;
  const at = await rallyPdas(programId).referral(quoteMint, referrer);
  const acc = await getAccount(rpc, at);
  if (!acc) return null;
  requireOwner(acc, programId, "ReferralAccount", at);
  return decodeReferral(acc.data);
}

// ── Raydium pool state ───────────────────────────────────────────────────────

/** Byte offset of `sqrt_price_x64` (u128) in Raydium's `PoolState`; `tick_current` (i32) follows it. */
const POOL_SQRT_PRICE_OFFSET = 253;
const POOL_TICK_OFFSET = 269;

export interface PoolSlot0 {
  tick: number;
  sqrtPriceX64: bigint;
}

/** Read price and tick out of raw `PoolState` bytes (layout pinned by the reference client). */
export function decodePoolSlot0(data: Uint8Array): PoolSlot0 {
  if (data.length < POOL_TICK_OFFSET + 4) {
    throw new RallyError("INVALID_ACCOUNT_DATA", "Raydium pool account is too short to be a PoolState");
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sqrtPriceX64 = dv.getBigUint64(POOL_SQRT_PRICE_OFFSET, true) | (dv.getBigUint64(POOL_SQRT_PRICE_OFFSET + 8, true) << 64n);
  return { tick: dv.getInt32(POOL_TICK_OFFSET, true), sqrtPriceX64 };
}

export async function fetchPoolSlot0(
  rpc: SolanaRpc,
  pool: Address,
  clmm: Address = RAYDIUM_CLMM_DEVNET,
): Promise<PoolSlot0> {
  const acc = await getAccount(rpc, pool);
  if (!acc) throw new RallyError("LAUNCH_NOT_FOUND", `Raydium pool ${pool} does not exist (open_pool not landed?)`);
  requireOwner(acc, clmm, "Raydium pool", pool);
  return decodePoolSlot0(acc.data);
}

/**
 * Spot price of a launch's token in WAD quote-per-token, off its Raydium pool. Pass the
 * quote's decimals from `QuoteConfig.decimals`, never an assumption. Throws when the pool
 * has not been opened yet (a launch is tradeable only after `open_pool`).
 */
export async function fetchLaunchPriceWad(
  rpc: SolanaRpc,
  launch: Pick<LaunchAccount, "pool">,
  quoteDecimals: number,
  clmm: Address = RAYDIUM_CLMM_DEVNET,
): Promise<bigint> {
  const { sqrtPriceX64 } = await fetchPoolSlot0(rpc, launch.pool, clmm);
  return priceWadFromSqrtPriceX64(sqrtPriceX64, quoteDecimals);
}

// ── Cluster clock ────────────────────────────────────────────────────────────

/**
 * The cluster's own unix time (seconds), read from the Clock sysvar: the clock the program
 * compares `deadline` against. The caller's clock can be minutes off, and a deadline
 * measured from it either expires instantly or protects nothing.
 */
export async function fetchClusterTime(rpc: SolanaRpc): Promise<bigint> {
  const acc = await getAccount(rpc, CLOCK_SYSVAR_ADDRESS);
  // Clock: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64.
  if (!acc || acc.data.length < 40) throw new RallyError("INVALID_ACCOUNT_DATA", "Could not read the Clock sysvar");
  return new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigInt64(32, true);
}
