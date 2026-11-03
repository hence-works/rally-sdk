import { AccountRole, isOffCurveAddress, type AccountMeta, type Address, type Instruction } from "@solana/kit";
import { RallyError } from "../errors";
import { fetchClusterTime, fetchFeeBeneficiary, fetchLaunch, fetchPoolSlot0, fetchQuoteConfig, type FeeBeneficiaryRpc, type SolanaRpc } from "./accounts";
import { sortsBelow } from "./address";
import { camel, encodeArgs } from "./codec";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  DEFAULT_POOL_SEED_INDEX,
  DEFAULT_RENT_BUDGET_LAMPORTS,
  RALLY_SOLANA_PROTOCOL_PROGRAM_ID,
  RAYDIUM_CLMM_DEVNET,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "./constants";
import { SOLANA_DEPLOYMENTS } from "./deployments.generated";
import { RALLY_SOLANA_PROTOCOL_IDL } from "./idl.generated";
import { findAssociatedTokenAddress, rallyPdas, raydiumPdas, tickArrayStart } from "./pda";
import { applySlippage, applySlippageExactOut, type SolanaSwapQuote } from "./quote";
import type { AddressOrSigner, CurveSegment, FeeConfig, LaunchAccount } from "./types";

// ── Shared shapes ────────────────────────────────────────────────────────────

/**
 * The unsigned result of every `prepare*`: kit-native instructions, in send order, plus
 * what a host needs to assemble and sign a transaction. Nothing here signs or sends, and a
 * host that does not use kit can read `programAddress`, `accounts` (address and role) and
 * `data` off each instruction. Roles are kit's `AccountRole` numbers (0 readonly, 1
 * writable, 2 readonly signer, 3 writable signer).
 */
export interface PreparedSolanaTransaction {
  /** In send order: idempotent ATA creations first, then the Rally instruction. */
  instructions: Instruction[];
  /** Addresses that must sign. The fee payer is the host's choice and is not listed unless it is one of these. */
  signers: Address[];
  /** The protocol lookup table to compile with, when the target has one baked or passed. */
  lookupTable?: Address;
}

/** Which program, Raydium deployment and lookup table to build against. */
export interface SolanaTarget {
  /** A Rally Solana chain id (7565164 / 7565165): fills the rest from the baked deployment, if any. */
  chainId?: number;
  programId?: Address;
  /** The Raydium CLMM program of the cluster (default devnet's, which is what the shipped IDL pins). */
  raydiumClmm?: Address;
  lookupTable?: Address;
}

interface Ctx {
  programId: Address;
  clmm: Address;
  lookupTable?: Address;
}

function resolveTarget(t: SolanaTarget): Ctx {
  const dep = t.chainId === undefined ? undefined : SOLANA_DEPLOYMENTS[t.chainId];
  const lookupTable = (t.lookupTable ?? dep?.lookupTable) as Address | undefined;
  return {
    programId: (t.programId ?? dep?.rallySolanaProtocol ?? RALLY_SOLANA_PROTOCOL_PROGRAM_ID) as Address,
    clmm: (t.raydiumClmm ?? dep?.raydiumClmm ?? RAYDIUM_CLMM_DEVNET) as Address,
    ...(lookupTable ? { lookupTable } : {}),
  };
}

/** Where on-chain state comes from: a decoded value the host already holds, or an RPC to read it. */
interface Reads {
  rpc?: SolanaRpc;
}

const addrOf = (a: AddressOrSigner): Address => (typeof a === "string" ? a : a.address);
const isSigner = (a: AddressOrSigner): a is { readonly address: Address } => typeof a !== "string";

const UNSET_POOL = "11111111111111111111111111111111";

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) {
    throw new RallyError("MISSING_ADDRESS", `${what} is required: pass it, or pass \`rpc\` so it can be read.`);
  }
  return v;
}

const finish = (
  ctx: Ctx,
  instructions: Instruction[],
  signers: AddressOrSigner[],
): PreparedSolanaTransaction => ({
  instructions,
  signers: [...new Set(signers.map(addrOf))],
  ...(ctx.lookupTable ? { lookupTable: ctx.lookupTable } : {}),
});

// ── Instruction builder (IDL driven) ─────────────────────────────────────────

type AccountMap = Record<string, AddressOrSigner | null | undefined>;

/**
 * Build one program instruction from the IDL: discriminator + Borsh args, and the account
 * list in the IDL's own order with the IDL's writable/signer flags. Every non-optional
 * account must be supplied (or carry a fixed address in the IDL); an unknown key is an
 * error, so a renamed account fails here instead of shifting the list by one on chain. An
 * omitted optional account is encoded as the program id, which is Anchor's convention.
 */
export function buildRallyInstruction(
  programId: Address,
  name: string,
  args: Record<string, unknown>,
  accounts: AccountMap,
  remaining: readonly Address[] = [],
): Instruction {
  const ix = RALLY_SOLANA_PROTOCOL_IDL.instructions.find((i) => i.name === name);
  if (!ix) throw new RallyError("UNSUPPORTED", `No instruction ${name} in the bundled IDL`);
  const known = new Set<string>(ix.accounts.map((a) => camel(a.name)));
  for (const k of Object.keys(accounts)) {
    if (!known.has(k)) throw new RallyError("UNSUPPORTED", `${name} has no account "${k}"`);
  }
  const metas = ix.accounts.map((a) => {
    const flags = a as { writable?: boolean; signer?: boolean; optional?: boolean; address?: string };
    const given = accounts[camel(a.name)];
    if (given === undefined || given === null) {
      if (flags.address) {
        return { address: flags.address as Address, role: flags.writable ? AccountRole.WRITABLE : AccountRole.READONLY };
      }
      if (flags.optional) return { address: programId, role: AccountRole.READONLY };
      throw new RallyError("MISSING_ADDRESS", `${name}: account "${a.name}" is required`);
    }
    const role = flags.signer
      ? flags.writable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : flags.writable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY;
    const meta = { address: addrOf(given), role };
    // A kit signer rides on the meta, which is what `signTransactionMessageWithSigners` reads.
    return (flags.signer && isSigner(given) ? { ...meta, signer: given } : meta) as AccountMeta;
  });
  const body = encodeArgs(ix.args as never, args);
  const data = new Uint8Array(8 + body.length);
  data.set(ix.discriminator, 0);
  data.set(body, 8);
  return {
    programAddress: programId,
    accounts: [...metas, ...remaining.map((address) => ({ address, role: AccountRole.WRITABLE }))],
    data,
  };
}

/** `AssociatedTokenAccount::CreateIdempotent`: a no-op when the account exists, so always safe to send first. */
export async function createAtaIdempotentInstruction(
  payer: AddressOrSigner,
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<Instruction> {
  const ata = await findAssociatedTokenAddress(owner, mint, tokenProgram);
  const payerMeta = { address: addrOf(payer), role: AccountRole.WRITABLE_SIGNER };
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    accounts: [
      (isSigner(payer) ? { ...payerMeta, signer: payer } : payerMeta) as AccountMeta,
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
    ],
    data: Uint8Array.of(1),
  };
}

// ── Helpers shared by the prepare* family ────────────────────────────────────

async function quoteProgramFor(
  quoteMint: Address,
  given: Address | undefined,
  rpc: SolanaRpc | undefined,
  ctx: Ctx,
): Promise<Address> {
  if (given) return given;
  if (!rpc) {
    throw new RallyError(
      "MISSING_ADDRESS",
      "`quoteTokenProgram` is required without `rpc`. A quote may be Token or Token-2022; read it from QuoteConfig.tokenProgram.",
    );
  }
  return (await fetchQuoteConfig(rpc, quoteMint, { programId: ctx.programId })).tokenProgram;
}

async function launchFor(
  mint: Address,
  given: LaunchAccount | undefined,
  rpc: SolanaRpc | undefined,
  ctx: Ctx,
): Promise<LaunchAccount> {
  const launch =
    given ?? (await fetchLaunch(need(rpc, "`launch` (a decoded Launch account)"), mint, { programId: ctx.programId }));
  if (launch.mint !== mint) {
    throw new RallyError("LAUNCH_NOT_FOUND", `The supplied Launch is for ${launch.mint}, not ${mint}`);
  }
  return launch;
}

function requirePoolOpen(launch: LaunchAccount): void {
  if (launch.pool === UNSET_POOL) {
    throw new RallyError("POOL_NOT_OPEN", `Launch ${launch.mint} has no pool yet: send open_pool first.`, {
      details: { mint: launch.mint },
    });
  }
}

function u64(v: bigint, label: string, { positive = true } = {}): bigint {
  if (typeof v !== "bigint") throw new RallyError("INVALID_AMOUNT", `${label} must be a bigint (base units)`);
  if (v < 0n || v >= 1n << 64n || (positive && v === 0n)) {
    throw new RallyError("INVALID_AMOUNT", `${label} must be ${positive ? "in 1..2^64-1" : "in 0..2^64-1"}: ${v}`, {
      details: { [label]: v.toString() },
    });
  }
  return v;
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
// Program limits (create_launch.rs): name 32, symbol 10, URI 200, all UTF-8 BYTES.
const MAX_NAME = 32;
const MAX_SYMBOL = 10;
const MAX_URI = 200;

/**
 * Shape check for the frozen metadata URI. Same schemes the EVM side accepts (https://,
 * ipfs://, inline data:application/json); the Solana program also caps it at 200 bytes,
 * so an inline document practically never fits and the pinned `https://` form is the norm.
 */
function checkMetadataUri(uri: string): string {
  const t = uri.trim();
  if (!/^(https:\/\/|ipfs:\/\/|data:application\/json)/i.test(t)) {
    throw new RallyError(
      "METADATA_REQUIRED",
      `metadataUri must be https://, ipfs:// or data:application/json. It is frozen onto the mint at launch. Got "${t.slice(0, 60)}".`,
    );
  }
  if (utf8Len(t) > MAX_URI) {
    throw new RallyError("METADATA_REQUIRED", `metadataUri is ${utf8Len(t)} bytes; the program allows ${MAX_URI}.`);
  }
  return t;
}

// ── create_launch ────────────────────────────────────────────────────────────

export interface PrepareCreateLaunchParams extends SolanaTarget, Reads {
  /** Pays the launch fee and rent; becomes the launch's creator. Signs. */
  creator: AddressOrSigner;
  /** The ground mint keypair (`grindMint`). Signs: that is what makes the address unhijackable. */
  mint: AddressOrSigner;
  quoteMint: Address;
  name: string;
  symbol: string;
  /** Pinned BEFORE this call at `/<chainId>/<mint>.json`. */
  metadataUri: string;
  /** Built-in 0 to 2, or a governance preset (id >= 3, pass `preset`). Default 0. */
  curvePreset?: number;
  customSegments?: CurveSegment[];
  /** `null` takes governance's default row. */
  feeConfig?: FeeConfig | null;
  breakoutFeeConfig?: FeeConfig | null;
  /** The governance preset account, when `curvePreset >= 3`. */
  preset?: Address;
  /** The creator's first buy in launch tokens (6dp). 0 for none; delivered by `open_pool`. */
  firstBuyTokens?: bigint;
  /** Defaults to the creator's ATA for the quote. It pays the launch fee, so it must hold it. */
  creatorQuoteAccount?: Address;
  /** The quote's token program; read from QuoteConfig when `rpc` is given. */
  quoteTokenProgram?: Address;
}

/**
 * Transaction 1 of 2. A launch is NOT tradeable until `prepareOpenPool` lands.
 *
 * The two do not fit one transaction (1,644 bytes even with the protocol lookup table,
 * against a 1,232 byte limit), so they are returned as separate prepared transactions.
 * Send them as two transactions, ideally as a Jito bundle so nothing can slot between
 * them. Splitting is safe: until `open_pool` lands there is no pool, and a pool squatted
 * on the default seed is sidestepped with another `seedIndex`.
 *
 * Enforces I-7 locally: a mint that sorts above its quote could never open its pool, and
 * by then the fee is paid and metadata pinned.
 */
export async function prepareCreateLaunch(p: PrepareCreateLaunchParams): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  const mint = addrOf(p.mint);
  const creator = addrOf(p.creator);
  if (!sortsBelow(mint, p.quoteMint)) {
    throw new RallyError(
      "MINT_MUST_SORT_BELOW_QUOTE",
      `Mint ${mint} must sort below the quote ${p.quoteMint} (I-7). Grind one with grindMint(quoteMint).`,
      { details: { mint, quoteMint: p.quoteMint } },
    );
  }
  if (!p.name || utf8Len(p.name) > MAX_NAME) {
    throw new RallyError("INVALID_AMOUNT", `name must be 1..${MAX_NAME} bytes`);
  }
  if (!p.symbol || utf8Len(p.symbol) > MAX_SYMBOL) {
    throw new RallyError("INVALID_AMOUNT", `symbol must be 1..${MAX_SYMBOL} bytes`);
  }
  const curvePreset = p.curvePreset ?? 0;
  if (curvePreset >= 3 && !p.preset && !(p.customSegments?.length)) {
    throw new RallyError("MISSING_ADDRESS", "curvePreset >= 3 needs the governance `preset` account");
  }
  const qp = await quoteProgramFor(p.quoteMint, p.quoteTokenProgram, p.rpc, ctx);
  const pdas = rallyPdas(ctx.programId);
  const launch = await pdas.launch(mint);
  const authority = await pdas.authority(launch);
  const [config, quoteConfig, quoteVault, eventAuthority, tokenVault, quoteLaunchVault, creatorQuote] = await Promise.all([
    pdas.config(),
    pdas.quoteConfig(p.quoteMint),
    pdas.quoteVault(p.quoteMint),
    pdas.eventAuthority(),
    findAssociatedTokenAddress(authority, mint, TOKEN_2022_PROGRAM_ADDRESS),
    findAssociatedTokenAddress(authority, p.quoteMint, qp),
    p.creatorQuoteAccount ? Promise.resolve(p.creatorQuoteAccount) : findAssociatedTokenAddress(creator, p.quoteMint, qp),
  ]);
  const ix = buildRallyInstruction(
    ctx.programId,
    "create_launch",
    {
      args: {
        name: p.name,
        symbol: p.symbol,
        metadataUri: checkMetadataUri(p.metadataUri),
        curvePreset,
        customSegments: p.customSegments ?? [],
        feeConfig: p.feeConfig ?? null,
        breakoutFeeConfig: p.breakoutFeeConfig ?? null,
        firstBuyTokens: u64(p.firstBuyTokens ?? 0n, "firstBuyTokens", { positive: false }),
      },
    },
    {
      creator: p.creator,
      config,
      quoteConfig,
      quoteMint: p.quoteMint,
      quoteVault,
      creatorQuoteAccount: creatorQuote,
      mint: p.mint,
      launch,
      authority,
      launchTokenVault: tokenVault,
      launchQuoteVault: quoteLaunchVault,
      preset: p.preset,
      feeNftMint: await pdas.feeBeneficiary(launch),
      creatorFeeNftAccount: await findAssociatedTokenAddress(creator, await pdas.feeBeneficiary(launch), TOKEN_2022_PROGRAM_ADDRESS),
      quoteTokenProgram: qp,
      eventAuthority,
      program: ctx.programId,
    },
  );
  return finish(ctx, [ix], [p.creator, p.mint]);
}

// ── open_pool ────────────────────────────────────────────────────────────────

export interface PrepareOpenPoolParams extends SolanaTarget, Reads {
  creator: AddressOrSigner;
  mint: Address;
  /** The decoded Launch (from `fetchLaunch`), to skip the read. */
  launch?: LaunchAccount;
  creatorQuoteAccount?: Address;
  /** Receives the first buy. Defaults to the creator's Token-2022 ATA, created idempotently. */
  creatorTokenAccount?: Address;
  /** Raydium pool seed (> 0); only has to be unused. Default 1. */
  seedIndex?: number;
  /**
   * Most quote the creator will pay for the first buy. REQUIRED when the launch has a first
   * buy (it is the slippage bound on it); with none, 0 is exact.
   */
  maxFirstBuyQuote?: bigint;
  /** Lamports advanced for Raydium's account rent (~0.29 SOL is used; the rest returns). Default 1.5 SOL. */
  rentBudget?: bigint;
  quoteTokenProgram?: Address;
}

/**
 * Transaction 2 of 2: creates the Raydium pool and opens the curve positions at the
 * post-first-buy price. Costs the creator roughly 0.29 SOL of rent, nearly all of it
 * Raydium tick arrays. Compile it with the protocol lookup table (`result.lookupTable`);
 * without it the transaction is over the size limit.
 */
export async function prepareOpenPool(p: PrepareOpenPoolParams): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  const launch = await launchFor(p.mint, p.launch, p.rpc, ctx);
  if (launch.creator !== addrOf(p.creator)) {
    throw new RallyError("NO_ACCOUNT", `Only the creator ${launch.creator} can open this pool`);
  }
  if (launch.pool !== UNSET_POOL) {
    throw new RallyError("UNSUPPORTED", `Launch ${p.mint} already has a pool (${launch.pool})`);
  }
  if (launch.firstBuyTokens > 0n && p.maxFirstBuyQuote === undefined) {
    throw new RallyError(
      "INVALID_AMOUNT",
      "maxFirstBuyQuote is required: this launch has a first buy, and the bound on what it may cost is yours to set.",
    );
  }
  const maxFirstBuyQuote = u64(p.maxFirstBuyQuote ?? 0n, "maxFirstBuyQuote", { positive: false });
  const seedIndex = p.seedIndex ?? DEFAULT_POOL_SEED_INDEX;
  const quoteMint = launch.quoteMint;
  const qp = await quoteProgramFor(quoteMint, p.quoteTokenProgram, p.rpc, ctx);
  const pdas = rallyPdas(ctx.programId);
  const ray = raydiumPdas(ctx.clmm);
  const creator = addrOf(p.creator);

  const launchPda = await pdas.launch(p.mint);
  const authority = await pdas.authority(launchPda);
  const pool = await ray.pool(launch.ammConfig, p.mint, quoteMint, seedIndex);
  const creatorToken = p.creatorTokenAccount ?? (await findAssociatedTokenAddress(creator, p.mint, TOKEN_2022_PROGRAM_ADDRESS));
  const creatorQuote = p.creatorQuoteAccount ?? (await findAssociatedTokenAddress(creator, quoteMint, qp));

  // Remaining accounts, per position: [nft, nft ATA, personal position, tick array lower, tick array upper].
  const remaining: Address[] = [];
  for (let i = 0; i < launch.numPositions; i++) {
    const pos = launch.positions[i]!;
    const nft = await pdas.positionNft(launchPda, i);
    remaining.push(
      nft,
      await findAssociatedTokenAddress(authority, nft, TOKEN_2022_PROGRAM_ADDRESS),
      await ray.personalPosition(nft),
      await ray.tickArray(pool, tickArrayStart(pos.tickLower)),
      await ray.tickArray(pool, tickArrayStart(pos.tickUpper)),
    );
  }

  const ix = buildRallyInstruction(
    ctx.programId,
    "open_pool",
    {
      args: {
        seedIndex,
        maxFirstBuyQuote,
        rentBudget: u64(p.rentBudget ?? DEFAULT_RENT_BUDGET_LAMPORTS, "rentBudget"),
      },
    },
    {
      creator: p.creator,
      launch: launchPda,
      authority,
      mint: p.mint,
      quoteConfig: await pdas.quoteConfig(quoteMint),
      quoteMint,
      launchTokenVault: await findAssociatedTokenAddress(authority, p.mint, TOKEN_2022_PROGRAM_ADDRESS),
      launchQuoteVault: await findAssociatedTokenAddress(authority, quoteMint, qp),
      creatorQuoteAccount: creatorQuote,
      creatorTokenAccount: creatorToken,
      clmmProgram: ctx.clmm,
      ammConfig: launch.ammConfig,
      poolState: pool,
      poolTokenVault: await ray.poolVault(pool, p.mint),
      poolQuoteVault: await ray.poolVault(pool, quoteMint),
      observationState: await ray.observation(pool),
      tickArrayBitmap: await ray.bitmap(pool),
      dynamicFeeConfig: undefined,
      quoteTokenProgram: qp,
      eventAuthority: await pdas.eventAuthority(),
      program: ctx.programId,
    },
    remaining,
  );
  const setup = p.creatorTokenAccount
    ? []
    : [await createAtaIdempotentInstruction(p.creator, creator, p.mint, TOKEN_2022_PROGRAM_ADDRESS)];
  return finish(ctx, [...setup, ix], [p.creator]);
}

// ── buy / sell ───────────────────────────────────────────────────────────────

export interface PrepareSwapParams extends SolanaTarget, Reads {
  trader: AddressOrSigner;
  mint: Address;
  /**
   * Exact input in base units: quote for a buy, launch tokens (6dp) for a sell. Required unless
   * `quote` is passed, in which case it defaults to the quote's own `amountIn` (and must equal it
   * when both are given).
   */
  amountIn?: bigint;
  /**
   * The minimum output in base units (tokens on a buy, quote on a sell). There is no default:
   * a swap with no bound is a market order for whoever sandwiches it. Must be >= 1. Pass it
   * directly, or pass `quote` + `slippageBps` and it is computed for you.
   */
  minOut?: bigint;
  /**
   * An exact quote from `quoteBuySolana` / `quoteSellSolana`. With it the swap needs no
   * simulation: its tick arrays become the swap's remaining accounts (the arrays the swap really
   * crosses, including liquidity other LPs added), and `minOut` can be derived from it.
   */
  quote?: SolanaSwapQuote;
  /**
   * Slippage tolerance in bps applied to `quote.amountOut` to derive `minOut`. Explicit by
   * design: it is only used when you pass it AND a `quote`, and never defaults. Mutually
   * exclusive with `minOut`.
   */
  slippageBps?: number;
  /**
   * Absolute deadline, unix seconds ON THE CLUSTER'S CLOCK. Pass this OR `deadlineSeconds`.
   * The program rejects the swap once its clock passes it.
   */
  deadline?: bigint;
  /**
   * Seconds from now, measured from the cluster's clock (the Clock sysvar, read through
   * `rpc`), never from the caller's. Default 120. Ignored when `deadline` is given.
   */
  deadlineSeconds?: number;
  /** A referrer who has run `register_referrer` for this quote; they earn a share of the platform cut. */
  referrer?: Address;
  /** The decoded Launch, to skip the read. */
  launch?: LaunchAccount;
  /** The pool's current tick, to skip the read (it selects which tick arrays the swap crosses). Ignored with `quote`. */
  currentTick?: number;
  traderTokenAccount?: Address;
  traderQuoteAccount?: Address;
  quoteTokenProgram?: Address;
}

async function prepareSwap(side: "buy" | "sell", p: PrepareSwapParams, exactOutput = false): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  if (p.quote) {
    if (!!p.quote.exactOutput !== exactOutput) throw new RallyError("INVALID_AMOUNT", "Quote exact-input/output mode does not match the instruction");
    if (p.quote.side !== side || p.quote.mint !== p.mint) {
      throw new RallyError(
        "INVALID_AMOUNT",
        `The supplied quote is a ${p.quote.side} for ${p.quote.mint}, not a ${side} for ${p.mint}`,
      );
    }
    if (p.amountIn !== undefined && p.amountIn !== (exactOutput ? p.quote.amountOut : p.quote.amountIn)) {
      throw new RallyError("INVALID_AMOUNT", "amountIn does not match the quote's amountIn: re-quote for the amount you are sending");
    }
  }
  const amountIn = u64(p.amountIn ?? (exactOutput ? p.quote?.amountOut : p.quote?.amountIn) ?? (undefined as unknown as bigint), exactOutput ? "amountOut" : "amountIn");
  let minOutRaw = p.minOut;
  if (p.slippageBps !== undefined) {
    if (p.minOut !== undefined) {
      throw new RallyError("INVALID_AMOUNT", "Pass minOut OR slippageBps, not both");
    }
    if (!p.quote) {
      throw new RallyError("INVALID_AMOUNT", "slippageBps derives minOut from a quote: pass `quote` too, or pass minOut");
    }
    minOutRaw = exactOutput ? applySlippageExactOut(p.quote.amountIn, p.slippageBps) : applySlippage(p.quote.amountOut, p.slippageBps);
  }
  const minOut = u64(minOutRaw as bigint, exactOutput ? "maxIn" : "minOut");
  const launch = await launchFor(p.mint, p.launch, p.rpc, ctx);
  requirePoolOpen(launch);
  if (p.quote && p.quote.pool !== launch.pool) {
    throw new RallyError("INVALID_AMOUNT", "The supplied quote is for a different pool than this launch's");
  }
  const quoteMint = launch.quoteMint;
  const qp = await quoteProgramFor(quoteMint, p.quoteTokenProgram, p.rpc, ctx);

  let deadline = p.deadline;
  if (deadline === undefined) {
    const now = await fetchClusterTime(need(p.rpc, "`deadline` (or `rpc`, to measure it from the cluster clock)"));
    const seconds = p.deadlineSeconds ?? 120;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new RallyError("INVALID_AMOUNT", "deadlineSeconds must be a positive safe integer");
    deadline = now + BigInt(seconds);
  }
  if (typeof deadline !== "bigint" || deadline <= 0n || deadline >= 1n << 63n) {
    throw new RallyError("INVALID_AMOUNT", "deadline must be a positive unix-seconds bigint");
  }

  const trader = addrOf(p.trader);
  const pdas = rallyPdas(ctx.programId);
  const ray = raydiumPdas(ctx.clmm);
  const launchPda = await pdas.launch(p.mint);
  const authority = await pdas.authority(launchPda);
  const traderToken = p.traderTokenAccount ?? (await findAssociatedTokenAddress(trader, p.mint, TOKEN_2022_PROGRAM_ADDRESS));
  const traderQuote = p.traderQuoteAccount ?? (await findAssociatedTokenAddress(trader, quoteMint, qp));

  // The initialized tick arrays the swap crosses, nearest first, behind the bitmap extension.
  // With a quote these are the arrays its replay actually crossed, read off the pool's own
  // bitmap, so liquidity another LP added is accounted for. Without one they are derived from
  // the launch's own positions, as in the reference client: a position another party opened in
  // an array this list lacks is not accounted for, which is the reason to pass a quote.
  const buy = side === "buy";
  let remaining: Address[];
  if (p.quote) {
    remaining = [await ray.bitmap(launch.pool), ...p.quote.tickArrays];
  } else {
    const owned = launch.positions.slice(0, launch.numPositions).map((x) => ({ lo: x.tickLower, hi: x.tickUpper }));
    if (launch.support.nftMint !== UNSET_POOL) owned.push({ lo: launch.support.tickLower, hi: launch.support.tickUpper });
    const starts = new Set<number>();
    for (const o of owned) {
      starts.add(tickArrayStart(o.lo));
      starts.add(tickArrayStart(o.hi));
    }
    const tick = p.currentTick ?? (await fetchPoolSlot0(need(p.rpc, "`currentTick`"), launch.pool, ctx.clmm)).tick;
    const cur = tickArrayStart(tick);
    const crossed = [...starts].filter((s) => (buy ? s >= cur : s <= cur)).sort((a, b) => (buy ? a - b : b - a));
    remaining = [await ray.bitmap(launch.pool), ...(await Promise.all(crossed.map((s) => ray.tickArray(launch.pool, s))))];
  }

  const ix = buildRallyInstruction(
    ctx.programId,
    exactOutput ? `${side}_exact_out` : side,
    exactOutput ? { amountOut: amountIn, maxIn: minOut, deadline } : { amountIn, minOut, deadline },
    {
      trader: p.trader,
      config: await pdas.config(),
      launch: launchPda,
      referral: p.referrer ? await pdas.referral(quoteMint, p.referrer) : undefined,
      referralVault: p.referrer ? await pdas.referralVault(await pdas.referral(quoteMint, p.referrer)) : undefined,
      authority,
      launchQuoteVault: await findAssociatedTokenAddress(authority, quoteMint, qp),
      mint: p.mint,
      quoteMint,
      traderTokenAccount: traderToken,
      traderQuoteAccount: traderQuote,
      clmmProgram: ctx.clmm,
      ammConfig: launch.ammConfig,
      poolState: launch.pool,
      poolTokenVault: await ray.poolVault(launch.pool, p.mint),
      poolQuoteVault: await ray.poolVault(launch.pool, quoteMint),
      observationState: await ray.observation(launch.pool),
      quoteTokenProgram: qp,
      eventAuthority: await pdas.eventAuthority(),
      program: ctx.programId,
    },
    remaining,
  );
  // The side that RECEIVES may not exist yet: create it idempotently (the trader pays rent).
  const setup = buy
    ? p.traderTokenAccount
      ? []
      : [await createAtaIdempotentInstruction(p.trader, trader, p.mint, TOKEN_2022_PROGRAM_ADDRESS)]
    : p.traderQuoteAccount
      ? []
      : [await createAtaIdempotentInstruction(p.trader, trader, quoteMint, qp)];
  return finish(ctx, [...setup, ix], [p.trader]);
}

/**
 * Exact-input buy: spend `amountIn` quote for at least `minOut` tokens before `deadline`.
 * A wSOL quote must already be wrapped in `traderQuoteAccount`; this does not wrap SOL.
 * `minOut` and the deadline are required inputs by design (see {@link PrepareSwapParams}).
 */
export const prepareBuy = (p: PrepareSwapParams) => prepareSwap("buy", p);

/** Exact-input sell: spend `amountIn` tokens for at least `minOut` quote before `deadline`. */
export const prepareSell = (p: PrepareSwapParams) => prepareSwap("sell", p);

export interface PrepareExactOutSwapParams extends Omit<PrepareSwapParams, "amountIn" | "minOut"> {
  /** Exact net output, or the matching exact-output quote's amountOut. */
  amountOut?: bigint;
  /** Explicit total input bound; alternatively pass quote + slippageBps. */
  maxIn?: bigint;
}
export const prepareBuyExactOut = (p: PrepareExactOutSwapParams) => prepareSwap("buy", { ...p, amountIn: p.amountOut, minOut: p.maxIn }, true);
export const prepareSellExactOut = (p: PrepareExactOutSwapParams) => prepareSwap("sell", { ...p, amountIn: p.amountOut, minOut: p.maxIn }, true);

// ── Claims, referrals, fee collection ────────────────────────────────────────

export interface PrepareClaimCreatorFeesParams extends SolanaTarget, Reads {
  /** Deprecated alias for payer. It does not select the recipient. */
  creator?: AddressOrSigner;
  /** Pays for recipient ATA creation only; unnecessary when holderQuoteAccount is supplied. */
  payer?: AddressOrSigner;
  /** Current NFT holder, or original creator after burn. Otherwise resolved through RPC. */
  holder?: AddressOrSigner;
  /** Explicit token account holding the NFT; null only after burn. */
  feeNftAccount?: Address | null;
  /** Mark the holder as a signer for CPI by the program controlling a PDA holder. */
  holderMustSign?: boolean;
  holderQuoteAccount?: Address;
  mint: Address;
  launch?: LaunchAccount;
  /** Deprecated alias for holderQuoteAccount. Must be the holder's canonical ATA. */
  creatorQuoteAccount?: Address;
  quoteTokenProgram?: Address;
}

/** Withdraw the creator bucket (already-earned fees; not new revenue). Subject to the escrow-until-breakout switch on `Config`. */
export async function prepareClaimCreatorFees(p: PrepareClaimCreatorFeesParams): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  const launch = await launchFor(p.mint, p.launch, p.rpc, ctx);
  const resolved = p.holder && p.feeNftAccount !== undefined ? undefined
    : await fetchFeeBeneficiary(need(p.rpc, "holder + feeNftAccount (or rpc to resolve the fee NFT)") as FeeBeneficiaryRpc, p.mint, { launch, programId: ctx.programId });
  const holder = p.holder ?? need(resolved?.holder, "holder");
  const holderAddress = addrOf(holder);
  const feeNftAccount = p.feeNftAccount !== undefined ? p.feeNftAccount : resolved!.feeNftAccount;
  if (resolved && holderAddress !== resolved.holder) throw new RallyError("NO_ACCOUNT", "Holder does not match current fee NFT owner");
  if (feeNftAccount === null && holderAddress !== launch.creator) throw new RallyError("NO_ACCOUNT", "Burned fee NFT pays the original creator");
  const quoteMint = launch.quoteMint;
  const qp = await quoteProgramFor(quoteMint, p.quoteTokenProgram, p.rpc, ctx);
  const pdas = rallyPdas(ctx.programId);
  const launchPda = await pdas.launch(p.mint);
  const authority = await pdas.authority(launchPda);
  const feeNftMint = await pdas.feeBeneficiary(launchPda);
  if (launch.feeNftMint !== feeNftMint) throw new RallyError("INVALID_ACCOUNT_DATA", "Register the launch's fee NFT before claiming");
  const destination = await findAssociatedTokenAddress(holderAddress, quoteMint, qp);
  const suppliedDestination = p.holderQuoteAccount ?? p.creatorQuoteAccount;
  if (suppliedDestination && suppliedDestination !== destination) throw new RallyError("NO_ACCOUNT", "Creator fees must go to the holder's canonical quote ATA");
  const ix = buildRallyInstruction(
    ctx.programId,
    "claim_creator_fees",
    {},
    {
      config: await pdas.config(),
      launch: launchPda,
      authority,
      quoteMint,
      launchQuoteVault: await findAssociatedTokenAddress(authority, quoteMint, qp),
      feeNftMint,
      feeNftAccount,
      holder,
      holderQuoteAccount: destination,
      quoteTokenProgram: qp,
      eventAuthority: await pdas.eventAuthority(),
      program: ctx.programId,
    },
  );
  // IDL cannot express the runtime off-curve signer condition. The controlling
  // program passes this inner instruction by CPI and supplies its PDA seeds.
  const holderMustSign = feeNftAccount !== null && (isOffCurveAddress(holderAddress) || p.holderMustSign === true);
  const claim = holderMustSign ? { ...ix, accounts: ix.accounts!.map((a, index) => index === 7 ? { ...a, role: AccountRole.READONLY_SIGNER, ...(isSigner(holder) ? { signer: holder } : {}) } : a) } : ix;
  const payer = p.payer ?? p.creator;
  const setup = suppliedDestination ? [] : [await createAtaIdempotentInstruction(need(payer, "payer for the holder quote ATA"), holderAddress, quoteMint, qp)];
  return finish(ctx, [...setup, claim], [...(setup.length ? [payer!] : []), ...(holderMustSign ? [holder] : [])]);
}

/** Permissionless registration of the recorded creator's NFT for legacy launches. */
export async function prepareRegisterFeeBeneficiary(p: SolanaTarget & Reads & { payer: AddressOrSigner; mint: Address; launch?: LaunchAccount }): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  const launch = await launchFor(p.mint, p.launch, p.rpc, ctx);
  const pdas = rallyPdas(ctx.programId);
  const at = await pdas.launch(p.mint);
  const feeNftMint = await pdas.feeBeneficiary(at);
  const ix = buildRallyInstruction(ctx.programId, "register_fee_beneficiary", {}, {
    payer: p.payer, launch: at, authority: await pdas.authority(at), feeNftMint,
    creator: launch.creator, creatorFeeNftAccount: await findAssociatedTokenAddress(launch.creator, feeNftMint, TOKEN_2022_PROGRAM_ADDRESS),
    eventAuthority: await pdas.eventAuthority(), program: ctx.programId,
  });
  return finish(ctx, [ix], [p.payer]);
}

export async function prepareSetCreatorClaimEscrow(p: SolanaTarget & { governance: AddressOrSigner; escrow: boolean }): Promise<PreparedSolanaTransaction> {
  if (typeof p.escrow !== "boolean") throw new RallyError("INVALID_AMOUNT", "escrow must be boolean");
  const ctx = resolveTarget(p);
  const pdas = rallyPdas(ctx.programId);
  return finish(ctx, [buildRallyInstruction(ctx.programId, "set_creator_claim_escrow", { escrow: p.escrow }, {
    governance: p.governance, config: await pdas.config(), eventAuthority: await pdas.eventAuthority(), program: ctx.programId,
  })], [p.governance]);
}

export async function prepareExtendAccount(p: SolanaTarget & { payer: AddressOrSigner; account: Address }): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  return finish(ctx, [buildRallyInstruction(ctx.programId, "extend_account", {}, {
    payer: p.payer, account: p.account, eventAuthority: await rallyPdas(ctx.programId).eventAuthority(), program: ctx.programId,
  })], [p.payer]);
}

export async function prepareMigrateReferral(p: SolanaTarget & Reads & { payer: AddressOrSigner; referrer: Address; quoteMint: Address; quoteTokenProgram?: Address }): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  const pdas = rallyPdas(ctx.programId);
  const referral = await pdas.referral(p.quoteMint, p.referrer);
  return finish(ctx, [buildRallyInstruction(ctx.programId, "migrate_referral", {}, {
    payer: p.payer, referral, referralVault: await pdas.referralVault(referral), quoteConfig: await pdas.quoteConfig(p.quoteMint),
    quoteVault: await pdas.quoteVault(p.quoteMint), quoteMint: p.quoteMint,
    quoteTokenProgram: await quoteProgramFor(p.quoteMint, p.quoteTokenProgram, p.rpc, ctx),
    eventAuthority: await pdas.eventAuthority(), program: ctx.programId,
  })], [p.payer]);
}

export interface PrepareReferralParams extends SolanaTarget, Reads {
  referrer: AddressOrSigner;
  quoteMint: Address;
  quoteTokenProgram?: Address;
}

/** One-time, per quote: the referrer pays the rent for their balance account so traders never do. */
export async function prepareRegisterReferrer(p: PrepareReferralParams): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  const pdas = rallyPdas(ctx.programId);
  const ix = buildRallyInstruction(
    ctx.programId,
    "register_referrer",
    {},
    {
      referrer: p.referrer,
      quoteConfig: await pdas.quoteConfig(p.quoteMint),
      quoteMint: p.quoteMint,
      referral: await pdas.referral(p.quoteMint, addrOf(p.referrer)),
      referralVault: await pdas.referralVault(await pdas.referral(p.quoteMint, addrOf(p.referrer))),
      quoteTokenProgram: await quoteProgramFor(p.quoteMint, p.quoteTokenProgram, p.rpc, ctx),
      eventAuthority: await pdas.eventAuthority(),
      program: ctx.programId,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
    },
  );
  return finish(ctx, [ix], [p.referrer]);
}

export interface PrepareClaimReferralFeesParams extends PrepareReferralParams {
  /** Defaults to the referrer's ATA for the quote, created idempotently. */
  referrerQuoteAccount?: Address;
}

export async function prepareClaimReferralFees(p: PrepareClaimReferralFeesParams): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  const qp = await quoteProgramFor(p.quoteMint, p.quoteTokenProgram, p.rpc, ctx);
  const pdas = rallyPdas(ctx.programId);
  const referrer = addrOf(p.referrer);
  const ix = buildRallyInstruction(
    ctx.programId,
    "claim_referral_fees",
    {},
    {
      referrer: p.referrer,
      referral: await pdas.referral(p.quoteMint, referrer),
      referralVault: await pdas.referralVault(await pdas.referral(p.quoteMint, referrer)),
      quoteMint: p.quoteMint,
      referrerQuoteAccount: p.referrerQuoteAccount ?? (await findAssociatedTokenAddress(referrer, p.quoteMint, qp)),
      quoteTokenProgram: qp,
      eventAuthority: await pdas.eventAuthority(),
      program: ctx.programId,
    },
  );
  const setup = p.referrerQuoteAccount ? [] : [await createAtaIdempotentInstruction(p.referrer, referrer, p.quoteMint, qp)];
  return finish(ctx, [...setup, ix], [p.referrer]);
}

export interface PrepareCollectFeesParams extends SolanaTarget, Reads {
  mint: Address;
  /** A curve position index (< `numPositions`), or 255 for the LP-support position. */
  index: number;
  launch?: LaunchAccount;
  quoteTokenProgram?: Address;
}

/** Permissionless: sweep a position's Raydium LP fees into the launch buckets. Needs no signer beyond the fee payer. */
export async function prepareCollectFees(p: PrepareCollectFeesParams): Promise<PreparedSolanaTransaction> {
  const ctx = resolveTarget(p);
  const launch = await launchFor(p.mint, p.launch, p.rpc, ctx);
  requirePoolOpen(launch);
  const support = p.index === 255;
  if (!support && !(Number.isInteger(p.index) && p.index >= 0 && p.index < launch.numPositions)) {
    throw new RallyError("INVALID_AMOUNT", `index must be 0..${launch.numPositions - 1} or 255 (LP support)`);
  }
  const pos = support ? launch.support : launch.positions[p.index]!;
  if (pos.nftMint === UNSET_POOL) throw new RallyError("INVALID_AMOUNT", "That position slot is empty");
  const quoteMint = launch.quoteMint;
  const qp = await quoteProgramFor(quoteMint, p.quoteTokenProgram, p.rpc, ctx);
  const pdas = rallyPdas(ctx.programId);
  const ray = raydiumPdas(ctx.clmm);
  const launchPda = await pdas.launch(p.mint);
  const authority = await pdas.authority(launchPda);
  const ix = buildRallyInstruction(
    ctx.programId,
    "collect_fees",
    { index: p.index },
    {
      launch: launchPda,
      authority,
      quoteConfig: await pdas.quoteConfig(quoteMint),
      quoteVault: await pdas.quoteVault(quoteMint),
      mint: p.mint,
      quoteMint,
      launchTokenVault: await findAssociatedTokenAddress(authority, p.mint, TOKEN_2022_PROGRAM_ADDRESS),
      launchQuoteVault: await findAssociatedTokenAddress(authority, quoteMint, qp),
      clmmProgram: ctx.clmm,
      poolState: launch.pool,
      poolTokenVault: await ray.poolVault(launch.pool, p.mint),
      poolQuoteVault: await ray.poolVault(launch.pool, quoteMint),
      personalPosition: await ray.personalPosition(pos.nftMint),
      nftAccount: await findAssociatedTokenAddress(authority, pos.nftMint, TOKEN_2022_PROGRAM_ADDRESS),
      tickArrayLower: await ray.tickArray(launch.pool, tickArrayStart(pos.tickLower)),
      tickArrayUpper: await ray.tickArray(launch.pool, tickArrayStart(pos.tickUpper)),
      tickArrayBitmap: await ray.bitmap(launch.pool),
      quoteTokenProgram: qp,
      eventAuthority: await pdas.eventAuthority(),
      program: ctx.programId,
    },
  );
  return finish(ctx, [ix], []);
}
