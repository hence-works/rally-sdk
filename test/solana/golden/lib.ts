/**
 * Helpers for the golden harness: send / simulate kit transactions against a local validator and
 * read the program's `RallySwap` / `FirstBuy` events back out of the inner instructions. Dev only.
 */
import {
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  fetchAddressesForLookupTables,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  partiallySignTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { createHash } from "node:crypto";
import { CLOCK_SYSVAR_ADDRESS } from "../../../src/solana";

export const RPC_URL = process.env.RALLY_GOLDEN_RPC ?? "http://127.0.0.1:8899";
export const rpc = createSolanaRpc(RPC_URL);

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
export const setComputeUnitLimit = (units: number): Instruction => ({
  programAddress: COMPUTE_BUDGET,
  data: Uint8Array.from([2, ...new Uint8Array(new Uint32Array([units]).buffer)]),
});

const b64 = getBase64Encoder();
const b58 = getBase58Encoder();

async function build(ixs: Instruction[], payer: KeyPairSigner, lookupTable?: Address, cu = 1_400_000, partial = false) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  let msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([setComputeUnitLimit(cu), ...ixs], m),
  );
  if (lookupTable) {
    const tables = await fetchAddressesForLookupTables([lookupTable], rpc);
    msg = compressTransactionMessageUsingAddressLookupTables(msg, tables) as typeof msg;
  }
  // A simulation does not verify signatures, so a signer that cannot sign (a no-op signer for an
  // address we do not hold the key of) may leave its slot empty.
  return partial ? partiallySignTransactionMessageWithSigners(msg) : signTransactionMessageWithSigners(msg);
}

export async function send(ixs: Instruction[], payer: KeyPairSigner, lookupTable?: Address): Promise<string> {
  const tx = await build(ixs, payer, lookupTable);
  const sig = getSignatureFromTransaction(tx);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" })
    .send();
  for (let i = 0; i < 150; i++) {
    const { value } = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`transaction ${sig} not confirmed`);
}

export interface SimResult {
  err: unknown;
  logs: string[];
  /** Unix time of the Clock sysvar the simulation ran against. */
  clock: bigint;
  events: Array<{ name: string; data: Uint8Array }>;
  unitsConsumed: bigint;
}

const disc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

export async function simulate(ixs: Instruction[], payer: KeyPairSigner, lookupTable?: Address): Promise<SimResult> {
  const tx = await build(ixs, payer, lookupTable, 1_400_000, true);
  const res = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(tx), {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      innerInstructions: true,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [CLOCK_SYSVAR_ADDRESS] },
    })
    .send();
  const v = res.value;
  const clockData = v.accounts?.[0]?.data;
  let clock = 0n;
  if (clockData) {
    const raw = new Uint8Array(b64.encode(clockData[0]));
    clock = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigInt64(32, true);
  }
  const events: SimResult["events"] = [];
  for (const group of v.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      // Parsed (known-program) instructions carry no raw data; our self-CPI events do.
      if (typeof (ix as { data?: unknown }).data !== "string") continue;
      const data = new Uint8Array(b58.encode((ix as { data: string }).data));
      if (data.length >= 16 && Buffer.from(data.subarray(0, 8)).toString("hex") === "e445a52e51cb9a1d") {
        const d = Buffer.from(data.subarray(8, 16)).toString("hex");
        for (const name of ["RallySwap", "FirstBuy", "Breakout"]) {
          if (Buffer.from(disc(name)).toString("hex") === d) events.push({ name, data: data.subarray(16) });
        }
      }
    }
  }
  return { err: v.err, logs: v.logs ?? [], clock, events, unitsConsumed: v.unitsConsumed ?? 0n };
}

// ── event decoding (layouts from programs/.../events.rs) ─────────────────────

export interface RallySwapEvent {
  isBuy: boolean;
  quoteAmount: bigint;
  tokenAmount: bigint;
  fee: bigint;
  sqrtPriceX64: bigint;
  tick: number;
}

export function decodeRallySwap(d: Uint8Array): RallySwapEvent {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 96; // launch, trader, referrer
  const isBuy = d[o]! === 1;
  o += 1;
  const u64 = () => {
    const v = dv.getBigUint64(o, true);
    o += 8;
    return v;
  };
  const quoteAmount = u64();
  const tokenAmount = u64();
  const fee = u64();
  const sqrtPriceX64 = dv.getBigUint64(o, true) | (dv.getBigUint64(o + 8, true) << 64n);
  o += 16;
  return { isBuy, quoteAmount, tokenAmount, fee, sqrtPriceX64, tick: dv.getInt32(o, true) };
}

export function decodeFirstBuy(d: Uint8Array): { quoteIn: bigint; tokensOut: bigint } {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { quoteIn: dv.getBigUint64(64, true), tokensOut: dv.getBigUint64(72, true) };
}

// ── small instruction builders ───────────────────────────────────────────────

export const SYSTEM = "11111111111111111111111111111111" as Address;

export function systemTransfer(from: KeyPairSigner, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM,
    accounts: [
      { address: from.address, role: 3, signer: from } as never,
      { address: to, role: 1 },
    ],
    data,
  };
}

export function syncNative(account: Address, tokenProgram: Address): Instruction {
  return { programAddress: tokenProgram, accounts: [{ address: account, role: 1 }], data: Uint8Array.of(17) };
}

export async function airdrop(to: Address, sol: number): Promise<void> {
  const sig = await rpc.requestAirdrop(to, BigInt(sol) * 1_000_000_000n as never).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("airdrop not confirmed");
}


// ── a local protocol lookup table ────────────────────────────────────────────

const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;

/**
 * The devnet protocol lookup table cannot be cloned usefully (its extension slot is in the
 * validator's future), so a local one is built with the same address list. Returns its address.
 */
export async function cloneLookupTable(devnetTable: Address, payer: KeyPairSigner): Promise<Address> {
  const { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } = await import("@solana/kit");
  const acc = await rpc.getAccountInfo(devnetTable, { encoding: "base64" }).send();
  const raw = new Uint8Array(b64.encode(acc.value!.data[0]));
  const addrs: Address[] = [];
  for (let o = 56; o + 32 <= raw.length; o += 32) addrs.push(getAddressDecoder().decode(raw.subarray(o, o + 32)));
  const slot = (await rpc.getSlot({ commitment: "confirmed" }).send()) - 1n;
  const slotLe = new Uint8Array(8);
  new DataView(slotLe.buffer).setBigUint64(0, slot, true);
  const [table, bump] = await getProgramDerivedAddress({
    programAddress: ALT_PROGRAM,
    seeds: [getAddressEncoder().encode(payer.address), slotLe],
  });
  const create = new Uint8Array(13);
  const cdv = new DataView(create.buffer);
  cdv.setUint32(0, 0, true);
  cdv.setBigUint64(4, slot, true);
  create[12] = bump;
  const signerMeta = (s: KeyPairSigner, role: number) => ({ address: s.address, role, signer: s }) as never;
  await send(
    [
      {
        programAddress: ALT_PROGRAM,
        accounts: [{ address: table, role: 1 }, signerMeta(payer, 2), signerMeta(payer, 3), { address: SYSTEM, role: 0 }],
        data: create,
      },
    ],
    payer,
  );
  for (let i = 0; i < addrs.length; i += 20) {
    const chunk = addrs.slice(i, i + 20);
    const ext = new Uint8Array(12 + chunk.length * 32);
    const edv = new DataView(ext.buffer);
    edv.setUint32(0, 2, true);
    edv.setBigUint64(4, BigInt(chunk.length), true);
    chunk.forEach((a, k) => ext.set(getAddressEncoder().encode(a), 12 + k * 32));
    await send(
      [
        {
          programAddress: ALT_PROGRAM,
          accounts: [{ address: table, role: 1 }, signerMeta(payer, 2), signerMeta(payer, 3), { address: SYSTEM, role: 0 }],
          data: ext,
        },
      ],
      payer,
    );
  }
  // A table is usable one slot after its last extension.
  await new Promise((r) => setTimeout(r, 1500));
  return table;
}

// ── an outside LP: a position opened on the launch's pool by someone who is not the launch ──

const OPEN_POSITION_WITH_TOKEN22_NFT = [77, 255, 174, 82, 125, 29, 201, 46];
const RENT = "SysvarRent111111111111111111111111111111111" as Address;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

/** Raydium `open_position_with_token22_nft`, exactly as the Rally program calls it, for an arbitrary LP. */
export async function openOutsidePosition(p: {
  lp: KeyPairSigner;
  nftMint: KeyPairSigner;
  clmm: Address;
  pool: Address;
  mint0: Address;
  mint1: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  lpToken0: Address;
  lpToken1: Address;
}): Promise<Instruction> {
  const { raydiumPdas, findAssociatedTokenAddress, tickArrayStart } = await import("../../../src/solana");
  const ray = raydiumPdas(p.clmm);
  const data = new Uint8Array(8 + 4 + 4 + 4 + 4 + 16 + 8 + 8 + 2);
  const dv = new DataView(data.buffer);
  data.set(OPEN_POSITION_WITH_TOKEN22_NFT, 0);
  dv.setInt32(8, p.tickLower, true);
  dv.setInt32(12, p.tickUpper, true);
  dv.setInt32(16, tickArrayStart(p.tickLower), true);
  dv.setInt32(20, tickArrayStart(p.tickUpper), true);
  dv.setBigUint64(24, p.liquidity & ((1n << 64n) - 1n), true);
  dv.setBigUint64(32, p.liquidity >> 64n, true);
  dv.setBigUint64(40, (1n << 64n) - 1n, true);
  dv.setBigUint64(48, (1n << 64n) - 1n, true);
  data[56] = 0; // with_metadata
  data[57] = 0; // base_flag None
  const w = (address: Address) => ({ address, role: 1 });
  const r = (address: Address) => ({ address, role: 0 });
  return {
    programAddress: p.clmm,
    accounts: [
      { address: p.lp.address, role: 3, signer: p.lp } as never,
      r(p.lp.address),
      { address: p.nftMint.address, role: 3, signer: p.nftMint } as never,
      w(await findAssociatedTokenAddress(p.lp.address, p.nftMint.address, TOKEN_2022)),
      w(p.pool),
      r(SYSTEM),
      w(await ray.tickArray(p.pool, tickArrayStart(p.tickLower))),
      w(await ray.tickArray(p.pool, tickArrayStart(p.tickUpper))),
      w(await ray.personalPosition(p.nftMint.address)),
      w(p.lpToken0),
      w(p.lpToken1),
      w(await ray.poolVault(p.pool, p.mint0)),
      w(await ray.poolVault(p.pool, p.mint1)),
      r(RENT),
      r(SYSTEM),
      r(TOKEN),
      r(ATA_PROGRAM),
      r(TOKEN_2022),
      r(p.mint0),
      r(p.mint1),
      w(await ray.bitmap(p.pool)),
    ] as never,
    data,
  };
}

/** Token-2022 `transfer_checked`. */
export function transferChecked(p: { source: Address; mint: Address; dest: Address; owner: KeyPairSigner; amount: bigint; decimals: number; program: Address }): Instruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, p.amount, true);
  data[9] = p.decimals;
  return {
    programAddress: p.program,
    accounts: [
      { address: p.source, role: 1 },
      { address: p.mint, role: 0 },
      { address: p.dest, role: 1 },
      { address: p.owner.address, role: 2, signer: p.owner } as never,
    ] as never,
    data,
  };
}
