import { createHash } from "node:crypto";
import { AccountRole, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  CLOCK_SYSVAR_ADDRESS,
  RALLY_LAUNCH_PROGRAM_ID,
  RAYDIUM_CLMM_DEVNET,
  RallyError,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  WSOL_MINT,
  buildRallyInstruction,
  findAssociatedTokenAddress,
  grindMint,
  prepareBuy,
  prepareClaimCreatorFees,
  prepareClaimReferralFees,
  prepareCollectFees,
  prepareCreateLaunch,
  prepareOpenPool,
  prepareRegisterReferrer,
  prepareSell,
  rallyPdas,
  raydiumPdas,
} from "../../src/solana";
import { W, ZERO, addr, fakeRpc, launchFixture } from "./fixtures";

/** Anchor: instruction discriminator = sha256("global:<name>")[0..8]. */
const ixDisc = (name: string) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];
const dataOf = (ix: { data?: ArrayLike<number> }) => Array.from(ix.data ?? []);
const last = <T>(xs: readonly T[]) => xs[xs.length - 1]!;

const TRADER = addr(20);
const MINT = addr(1);
const QUOTE = addr(3);
const common = { trader: TRADER, mint: MINT, launch: launchFixture(), currentTick: -1000, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS };

describe("buy / sell", () => {
  const params = { ...common, amountIn: 1_000_000_000n, minOut: 5_000_000n, deadline: 1_700_000_120n };

  it("encode discriminator, amount_in u64 LE, min_out u64 LE, deadline i64 LE", async () => {
    for (const [fn, name] of [[prepareBuy, "buy"], [prepareSell, "sell"]] as const) {
      const tx = await fn(params);
      const ix = last(tx.instructions);
      const expected = new W().raw(ixDisc(name)).int(1_000_000_000n, 8).int(5_000_000n, 8).int(1_700_000_120n, 8).bytes();
      expect(dataOf(ix)).toEqual(Array.from(expected));
    }
  });

  it("has the IDL's account list, the trader as the only signer, and a program-id placeholder for the omitted referral", async () => {
    const ix = last((await prepareBuy(params)).instructions);
    const accts = ix.accounts!;
    expect(accts[0]).toMatchObject({ address: TRADER, role: AccountRole.READONLY_SIGNER });
    // 24 IDL accounts, then the remaining tick arrays.
    const idlCount = 24;
    expect(accts.slice(0, idlCount)).toHaveLength(idlCount);
    expect(accts[5]).toMatchObject({ address: RALLY_LAUNCH_PROGRAM_ID, role: AccountRole.READONLY }); // referral = None
    expect(accts[12]!.address).toBe(RAYDIUM_CLMM_DEVNET);
    expect(accts[18]!.address).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(accts[19]!.address).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    expect(accts[22]!.address).toBe(await rallyPdas().eventAuthority());
    expect(accts[23]!.address).toBe(RALLY_LAUNCH_PROGRAM_ID);
    expect(accts.filter((a) => a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER)).toHaveLength(1);
  });

  it("passes the referral PDA when a referrer is given", async () => {
    const ref = addr(30);
    const ix = last((await prepareBuy({ ...params, referrer: ref })).instructions);
    expect(ix.accounts![5]).toMatchObject({ address: await rallyPdas().referral(QUOTE, ref), role: AccountRole.WRITABLE });
  });

  it("appends the bitmap then only the tick arrays ahead of the price: ascending on a buy, descending on a sell", async () => {
    const pool = params.launch.pool;
    const r = raydiumPdas();
    const buy = last((await prepareBuy(params)).instructions).accounts!.slice(24);
    // Positions: [-7200, 3600] and [-3600, 7200] -> array starts -7200, 3600, -3600, 7200; tick -1000 is in array -3600.
    expect(buy.map((a) => a.address)).toEqual([
      await r.bitmap(pool),
      await r.tickArray(pool, -3600),
      await r.tickArray(pool, 3600),
      await r.tickArray(pool, 7200),
    ]);
    const sell = last((await prepareSell(params)).instructions).accounts!.slice(24);
    expect(sell.map((a) => a.address)).toEqual([
      await r.bitmap(pool),
      await r.tickArray(pool, -3600),
      await r.tickArray(pool, -7200),
    ]);
    expect(buy.every((a) => a.role === AccountRole.WRITABLE)).toBe(true);
  });

  it("creates the receiving ATA idempotently first: tokens on a buy, quote on a sell", async () => {
    const buy = await prepareBuy(params);
    expect(buy.instructions).toHaveLength(2);
    expect(buy.instructions[0]!.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(dataOf(buy.instructions[0]!)).toEqual([1]);
    expect(buy.instructions[0]!.accounts![1]!.address).toBe(await findAssociatedTokenAddress(TRADER, MINT, TOKEN_2022_PROGRAM_ADDRESS));
    const sell = await prepareSell(params);
    expect(sell.instructions[0]!.accounts![1]!.address).toBe(await findAssociatedTokenAddress(TRADER, QUOTE, TOKEN_PROGRAM_ADDRESS));
    expect(sell.signers).toEqual([TRADER]);
  });

  describe("minOut is required and never defaulted", () => {
    it("throws on a missing minOut (JS caller)", async () => {
      const { minOut: _m, ...rest } = params;
      await expect(prepareBuy(rest as never)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    });
    it("throws on 0", async () => {
      await expect(prepareBuy({ ...params, minOut: 0n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
      await expect(prepareSell({ ...params, minOut: 0n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    });
    it("throws on amountIn 0, over u64, or a non-bigint", async () => {
      await expect(prepareBuy({ ...params, amountIn: 0n })).rejects.toBeInstanceOf(RallyError);
      await expect(prepareBuy({ ...params, amountIn: 1n << 64n })).rejects.toBeInstanceOf(RallyError);
      await expect(prepareBuy({ ...params, amountIn: 5 as never })).rejects.toBeInstanceOf(RallyError);
    });
  });

  describe("deadline", () => {
    const { deadline: _d, ...noDeadline } = params;
    it("is measured from the CLUSTER clock, not the caller's", async () => {
      const clock = new W().int(5, 8).int(0, 8).int(1, 8).int(1, 8).int(1_234_567_890n, 8).bytes();
      const rpc = fakeRpc({ [CLOCK_SYSVAR_ADDRESS]: { data: clock, owner: addr(7) } });
      const ix = last((await prepareBuy({ ...noDeadline, rpc, deadlineSeconds: 90 })).instructions);
      const expected = new W().raw(ixDisc("buy")).int(1_000_000_000n, 8).int(5_000_000n, 8).int(1_234_567_890n + 90n, 8).bytes();
      expect(dataOf(ix)).toEqual(Array.from(expected));
    });
    it("defaults to 120s past the cluster clock", async () => {
      const clock = new W().int(5, 8).int(0, 8).int(1, 8).int(1, 8).int(1_000n, 8).bytes();
      const rpc = fakeRpc({ [CLOCK_SYSVAR_ADDRESS]: { data: clock, owner: addr(7) } });
      const ix = last((await prepareBuy({ ...noDeadline, rpc })).instructions);
      expect(dataOf(ix).slice(24)).toEqual(Array.from(new W().int(1_120n, 8).bytes()));
    });
    it("with neither a deadline nor an rpc, refuses rather than guessing from the local clock", async () => {
      await expect(prepareBuy(noDeadline)).rejects.toMatchObject({ code: "MISSING_ADDRESS" });
    });
  });

  it("refuses a launch whose pool is not open yet", async () => {
    await expect(prepareBuy({ ...params, launch: launchFixture({ pool: ZERO }) })).rejects.toMatchObject({ code: "POOL_NOT_OPEN" });
  });
  it("refuses a Launch for a different mint", async () => {
    await expect(prepareBuy({ ...params, mint: addr(99) })).rejects.toMatchObject({ code: "LAUNCH_NOT_FOUND" });
  });
  it("needs the quote token program from the caller or an rpc", async () => {
    const { quoteTokenProgram: _q, ...rest } = params;
    await expect(prepareBuy(rest)).rejects.toMatchObject({ code: "MISSING_ADDRESS" });
  });
});

describe("create_launch", () => {
  it("encodes CreateLaunchArgs in Borsh and checks I-7", async () => {
    const ground = await grindMint(WSOL_MINT);
    const creator = addr(40);
    const tx = await prepareCreateLaunch({
      creator,
      mint: ground.signer,
      quoteMint: WSOL_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
      name: "Rally",
      symbol: "RLY",
      metadataUri: "https://example.com/7565165/x.json",
      firstBuyTokens: 10_000_000_000n,
    });
    const ix = last(tx.instructions);
    const expected = new W()
      .raw(ixDisc("create_launch"))
      .str("Rally")
      .str("RLY")
      .str("https://example.com/7565165/x.json")
      .u8(0) // curve_preset
      .int(0, 4) // custom_segments: empty vec
      .u8(0) // fee_config: None
      .u8(0) // breakout_fee_config: None
      .int(10_000_000_000n, 8)
      .bytes();
    expect(dataOf(ix)).toEqual(Array.from(expected));
    expect(tx.signers).toEqual([creator, ground.address]);
    // creator is WRITABLE_SIGNER, mint (index 6) is a WRITABLE_SIGNER carrying the keypair signer.
    expect(ix.accounts![0]).toMatchObject({ address: creator, role: AccountRole.WRITABLE_SIGNER });
    expect(ix.accounts![6]).toMatchObject({ address: ground.address, role: AccountRole.WRITABLE_SIGNER, signer: ground.signer });
    expect(ix.accounts![11]).toMatchObject({ address: RALLY_LAUNCH_PROGRAM_ID, role: AccountRole.READONLY }); // preset None
  });

  it("rejects a mint that sorts above its quote, before anything is pinned or paid", async () => {
    await expect(
      prepareCreateLaunch({
        creator: addr(40),
        mint: addr(0xff),
        quoteMint: WSOL_MINT,
        quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
        name: "A",
        symbol: "A",
        metadataUri: "https://x.test/a.json",
      }),
    ).rejects.toMatchObject({ code: "MINT_MUST_SORT_BELOW_QUOTE" });
  });

  it("validates name, symbol and URI against the program's byte limits", async () => {
    const base = { creator: addr(40), mint: addr(0), quoteMint: WSOL_MINT, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS, name: "A", symbol: "A", metadataUri: "https://x.test/a.json" };
    await expect(prepareCreateLaunch({ ...base, name: "x".repeat(33) })).rejects.toBeInstanceOf(RallyError);
    await expect(prepareCreateLaunch({ ...base, symbol: "" })).rejects.toBeInstanceOf(RallyError);
    await expect(prepareCreateLaunch({ ...base, symbol: "ééééée" })).rejects.toBeInstanceOf(RallyError); // 12 bytes
    await expect(prepareCreateLaunch({ ...base, metadataUri: "ftp://x" })).rejects.toMatchObject({ code: "METADATA_REQUIRED" });
    await expect(prepareCreateLaunch({ ...base, metadataUri: "https://x.test/" + "a".repeat(200) })).rejects.toMatchObject({ code: "METADATA_REQUIRED" });
  });
});

describe("open_pool", () => {
  const creator = addr(2);
  const launch = launchFixture({ pool: ZERO, firstBuyTokens: 5n });
  const base = { creator, mint: MINT, launch, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS };

  it("encodes OpenPoolArgs and lays out five remaining accounts per position", async () => {
    const tx = await prepareOpenPool({ ...base, maxFirstBuyQuote: 777n, seedIndex: 3, rentBudget: 2_000_000_000n });
    const ix = last(tx.instructions);
    expect(dataOf(ix)).toEqual(Array.from(new W().raw(ixDisc("open_pool")).int(3, 2).int(777n, 8).int(2_000_000_000n, 8).bytes()));
    const idlCount = 26;
    expect(ix.accounts).toHaveLength(idlCount + 2 * 5);
    const pool = await raydiumPdas().pool(launch.ammConfig, MINT, QUOTE, 3);
    expect(ix.accounts![12]!.address).toBe(pool);
    const rem = ix.accounts!.slice(idlCount);
    const lp = await rallyPdas().launch(MINT);
    const nft0 = await rallyPdas().positionNft(lp, 0);
    expect(rem[0]!.address).toBe(nft0);
    expect(rem[1]!.address).toBe(await findAssociatedTokenAddress(await rallyPdas().authority(lp), nft0, TOKEN_2022_PROGRAM_ADDRESS));
    expect(rem[2]!.address).toBe(await raydiumPdas().personalPosition(nft0));
    expect(rem[3]!.address).toBe(await raydiumPdas().tickArray(pool, -7200));
    expect(rem[4]!.address).toBe(await raydiumPdas().tickArray(pool, 3600));
    expect(rem.every((a) => a.role === AccountRole.WRITABLE)).toBe(true);
    // the first-buy token ATA is created first
    expect(tx.instructions[0]!.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(tx.signers).toEqual([creator]);
  });

  it("requires maxFirstBuyQuote when the launch has a first buy", async () => {
    await expect(prepareOpenPool(base)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    const noBuy = await prepareOpenPool({ ...base, launch: launchFixture({ pool: ZERO }) });
    expect(last(noBuy.instructions).data).toBeDefined();
  });

  it("is creator-only and one-shot", async () => {
    await expect(prepareOpenPool({ ...base, creator: addr(77), maxFirstBuyQuote: 1n })).rejects.toMatchObject({ code: "NO_ACCOUNT" });
    await expect(prepareOpenPool({ ...base, launch: launchFixture({ firstBuyTokens: 5n }), maxFirstBuyQuote: 1n })).rejects.toBeInstanceOf(RallyError);
  });
});

describe("claims, referrals, fee collection", () => {
  const launch = launchFixture();
  it("claim_creator_fees: no args, creator signs", async () => {
    const tx = await prepareClaimCreatorFees({ creator: addr(2), mint: MINT, launch, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS });
    const ix = last(tx.instructions);
    expect(dataOf(ix)).toEqual(ixDisc("claim_creator_fees"));
    expect(ix.accounts![0]).toMatchObject({ address: addr(2), role: AccountRole.READONLY_SIGNER });
    await expect(prepareClaimCreatorFees({ creator: addr(9), mint: MINT, launch, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS })).rejects.toMatchObject({ code: "NO_ACCOUNT" });
  });
  it("register_referrer / claim_referral_fees", async () => {
    const referrer = addr(50);
    const reg = last((await prepareRegisterReferrer({ referrer, quoteMint: QUOTE })).instructions);
    expect(dataOf(reg)).toEqual(ixDisc("register_referrer"));
    expect(reg.accounts![0]).toMatchObject({ address: referrer, role: AccountRole.WRITABLE_SIGNER });
    expect(reg.accounts![2]!.address).toBe(await rallyPdas().referral(QUOTE, referrer));
    const claim = last((await prepareClaimReferralFees({ referrer, quoteMint: QUOTE, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS })).instructions);
    expect(dataOf(claim)).toEqual(ixDisc("claim_referral_fees"));
    expect(claim.accounts).toHaveLength(9);
  });
  it("collect_fees: index arg u8, no signer", async () => {
    const tx = await prepareCollectFees({ mint: MINT, index: 1, launch, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(dataOf(last(tx.instructions))).toEqual([...ixDisc("collect_fees"), 1]);
    expect(tx.signers).toEqual([]);
    await expect(prepareCollectFees({ mint: MINT, index: 5, launch, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS })).rejects.toBeInstanceOf(RallyError);
    await expect(prepareCollectFees({ mint: MINT, index: 255, launch, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS })).rejects.toBeInstanceOf(RallyError); // no support position yet
  });
});

describe("buildRallyInstruction", () => {
  it("rejects an account name the instruction does not have and a missing required one", () => {
    expect(() => buildRallyInstruction(RALLY_LAUNCH_PROGRAM_ID, "register_referrer", {}, { nope: addr(1) })).toThrow(/no account/);
    expect(() => buildRallyInstruction(RALLY_LAUNCH_PROGRAM_ID, "register_referrer", {}, {})).toThrow(/required/);
  });
  it("every instruction in the IDL carries its anchor discriminator", async () => {
    const { RALLY_LAUNCH_IDL } = await import("../../src/solana");
    for (const ix of RALLY_LAUNCH_IDL.instructions) {
      expect([...ix.discriminator], ix.name).toEqual(ixDisc(ix.name));
    }
  });
});

void (null as unknown as Address);
