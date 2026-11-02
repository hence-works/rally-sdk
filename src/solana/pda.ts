import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  RALLY_SOLANA_PROTOCOL_PROGRAM_ID,
  RAYDIUM_CLMM_DEVNET,
  TICK_ARRAY_SIZE,
  TICK_SPACING,
} from "./constants";

/**
 * PDA derivations, ported seed for seed from the reference client
 * (`packages/rally-solana/ts/src/client.ts`, proven against the program by its e2e
 * tests). All async: kit derives through WebCrypto.
 */

const te = new TextEncoder();
const enc = getAddressEncoder();
const key = (a: Address) => new Uint8Array(enc.encode(a));
const u8 = (n: number) => Uint8Array.of(n);
const u16le = (n: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};
const i32be = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, false);
  return b;
};
const u64le = (n: bigint | number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};

async function derive(programAddress: Address, seeds: Uint8Array[]): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress, seeds });
  return a;
}

/** PDAs of the Rally Solana protocol program (default: the shipped program id). */
export function rallyPdas(programId: Address = RALLY_SOLANA_PROTOCOL_PROGRAM_ID) {
  const p = (...seeds: Uint8Array[]) => derive(programId, seeds);
  return {
    config: () => p(te.encode("config")),
    quoteConfig: (quoteMint: Address) => p(te.encode("quote"), key(quoteMint)),
    quoteVault: (quoteMint: Address) => p(te.encode("quote_vault"), key(quoteMint)),
    launch: (mint: Address) => p(te.encode("launch"), key(mint)),
    authority: (launch: Address) => p(te.encode("authority"), key(launch)),
    positionNft: (launch: Address, index: number) => p(te.encode("position_nft"), key(launch), u8(index)),
    supportNft: (launch: Address, nonce: number) => p(te.encode("support_nft"), key(launch), u16le(nonce)),
    referral: (quoteMint: Address, referrer: Address) =>
      p(te.encode("referral"), key(quoteMint), key(referrer)),
    dividend: (launch: Address, epoch: bigint | number) => p(te.encode("dividend"), key(launch), u64le(epoch)),
    dividendClaim: (epoch: Address, index: bigint | number) =>
      p(te.encode("dividend_claim"), key(epoch), u64le(index)),
    eventAuthority: () => p(te.encode("__event_authority")),
  };
}

/** PDAs of the Raydium CLMM program a launch's pool lives under. */
export function raydiumPdas(clmm: Address = RAYDIUM_CLMM_DEVNET) {
  const p = (...seeds: Uint8Array[]) => derive(clmm, seeds);
  return {
    pool: (ammConfig: Address, mint0: Address, mint1: Address, seedIndex: number) =>
      p(te.encode("pool"), key(ammConfig), key(mint0), key(mint1), u16le(seedIndex)),
    poolVault: (pool: Address, mint: Address) => p(te.encode("pool_vault"), key(pool), key(mint)),
    observation: (pool: Address) => p(te.encode("observation"), key(pool)),
    bitmap: (pool: Address) => p(te.encode("pool_tick_array_bitmap_extension"), key(pool)),
    tickArray: (pool: Address, startTick: number) => p(te.encode("tick_array"), key(pool), i32be(startTick)),
    personalPosition: (nftMint: Address) => p(te.encode("position"), key(nftMint)),
  };
}

/** The associated token account of `owner` for `mint` under `tokenProgram` (works for PDA owners). */
export function findAssociatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address) {
  return derive(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, [key(owner), key(tokenProgram), key(mint)]);
}

/** Start tick of the Raydium tick array holding `tick` (spacing 60, 60 ticks per array). */
export function tickArrayStart(tick: number): number {
  const span = TICK_SPACING * TICK_ARRAY_SIZE;
  return Math.floor(tick / span) * span;
}
