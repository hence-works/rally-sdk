import { describe, expect, it } from "vitest";
import * as sdk from "../../src/solana";
import { addr, launchFixture, W, fakeRpc } from "./fixtures";
import { MINT, rpcFor } from "./golden/load";
import { computeSwapStep, Q64 } from "../../src/solana/clmm";
import { AccountRole } from "@solana/kit";

const base = { trader: addr(20), mint: addr(1), launch: launchFixture(), currentTick: -1000,
  quoteTokenProgram: sdk.TOKEN_PROGRAM_ADDRESS, deadline: 1700000120n };

describe("Wave 0 public contract", () => {
  it("removes shared quote writes and carries paired referral vaults", async () => {
    const ix = (await sdk.prepareBuy({ ...base, amountIn: 100n, minOut: 1n, referrer: addr(30) })).instructions.at(-1)!;
    const referral = await sdk.rallyPdas().referral(addr(3), addr(30));
    expect(ix.accounts![3]!.address).toBe(referral);
    expect(ix.accounts![4]!.address).toBe(await sdk.rallyPdas().referralVault(referral));
    expect(ix.accounts!.some(a => a.address === sdk.RALLY_SOLANA_PROTOCOL_PROGRAM_ID && a.role === 1)).toBe(false);
  });
  it("encodes exact-output bounds and refuses absent/zero maxIn", async () => {
    for (const fn of [sdk.prepareBuyExactOut, sdk.prepareSellExactOut]) {
      expect(typeof fn).toBe("function");
      const tx = await fn({ ...base, amountOut: 5n, maxIn: 101n });
      expect(Array.from(tx.instructions.at(-1)!.data!).slice(8)).toEqual(Array.from(new W().int(5n,8).int(101n,8).int(base.deadline,8).bytes()));
      await expect(fn({ ...base, amountOut: 5n, maxIn: 0n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
      await expect(fn({ ...base, amountOut: 5n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    }
  });
  it("quotes exact output with integer ceiling on maxIn", async () => {
    expect(typeof sdk.quoteBuyExactOutSolana).toBe("function");
    const buy = await sdk.quoteBuyExactOutSolana({ rpc: rpcFor("fresh"), mint: MINT, amountOut: 10000000000n, timestamp: 1n << 40n, slippageBps: 50 });
    expect(buy.amountOut).toBe(10000000000n);
    expect(buy.maxIn).toBe((buy.amountIn * 10050n + 9999n) / 10000n);
    expect(buy.fees.routerFee).toBe(((buy.amountIn - buy.fees.routerFee) * 100n + 9899n) / 9900n);
    const sell = await sdk.quoteSellExactOutSolana({ rpc: rpcFor("moved"), mint: MINT, amountOut: 1000000n, timestamp: 1n << 40n });
    expect(sell.amountOut).toBe(1000000n);
    expect(sell.fees.routerFee).toBe((1000000n * 100n + 9899n) / 9900n);
    expect(sell.maxIn).toBeUndefined();
  });

  it("rejects mixed quote modes, mismatched output, missing slippage and u64/i64 overflow", async () => {
    const q = await sdk.quoteBuyExactOutSolana({ rpc: rpcFor("fresh"), mint: MINT, amountOut: 10000000000n, timestamp: 1n << 40n, slippageBps: 50 });
    await expect(sdk.prepareBuyExactOut({ ...base, mint: MINT, quote: q })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(sdk.prepareBuy({ ...base, mint: MINT, quote: q, minOut: 1n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(sdk.prepareBuyExactOut({ ...base, mint: MINT, quote: q, amountOut: q.amountOut + 1n, maxIn: q.amountIn })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(sdk.prepareBuyExactOut({ ...base, amountOut: 1n, maxIn: 1n << 64n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(sdk.prepareBuyExactOut({ ...base, amountOut: 1n, maxIn: 1n, deadline: 1n << 63n })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    expect(() => sdk.applySlippageExactOut((1n << 64n) - 1n, 1)).toThrow(sdk.RallyError);
    expect(sdk.applySlippageExactOut(1n, 1)).toBe(2n);
  });

  it("uses real quote tick arrays and explicit ceiling slippage in exact-output preparation", async () => {
    const q = await sdk.quoteBuyExactOutSolana({ rpc: rpcFor("fresh"), mint: MINT, amountOut: 10000000000n, timestamp: 1n << 40n });
    const tx = await sdk.prepareBuyExactOut({ rpc: rpcFor("fresh"), mint: MINT, trader: addr(20), quote: q, slippageBps: 75, deadline: base.deadline, quoteTokenProgram: sdk.TOKEN_PROGRAM_ADDRESS });
    const ix = tx.instructions.at(-1)!;
    expect(new DataView(ix.data!.buffer, ix.data!.byteOffset).getBigUint64(16,true)).toBe(sdk.applySlippageExactOut(q.amountIn,75));
    expect(ix.accounts!.slice(24).map(a=>a.address)).toEqual(q.tickArrays);
  });

  it("exact-output single-step rounding agrees with rational constant-product amounts", () => {
    // Price starts at 1, L = 1024. Buying 512 token0 costs exactly 1024 token1.
    const buy = computeSwapStep(Q64, 3n * Q64, 1024n, 512n, 0n, false, true, false);
    expect(buy).toEqual({ sqrtPriceNextX64: 2n * Q64, amountIn: 1024n, amountOut: 512n, feeAmount: 0n });
    // Selling for 512 token1 moves sqrtP to 1/2 and costs exactly 1024 token0.
    const sell = computeSwapStep(Q64, Q64 / 4n, 1024n, 512n, 0n, true, false, false);
    expect(sell).toEqual({ sqrtPriceNextX64: Q64 / 2n, amountIn: 1024n, amountOut: 512n, feeAmount: 0n });
    const feeBuy = computeSwapStep(Q64, 3n * Q64, 1024n, 512n, 2500n, false, true, false);
    expect(feeBuy.feeAmount).toBe(3n);
    const feeSell = computeSwapStep(Q64, Q64 / 4n, 1024n, 510n, 2500n, true, false, false);
    expect(feeSell).toEqual({ sqrtPriceNextX64: Q64 / 2n, amountIn: 1024n, amountOut: 510n, feeAmount: 2n });
    // Generic Raydium fee modes also support the other direction.
    expect(computeSwapStep(Q64, Q64 / 4n, 1024n, 512n, 2500n, true, true, false))
      .toEqual({ sqrtPriceNextX64: Q64 / 2n, amountIn: 1024n, amountOut: 512n, feeAmount: 3n });
    expect(computeSwapStep(Q64, 3n * Q64, 1024n, 510n, 2500n, false, false, false))
      .toEqual({ sqrtPriceNextX64: 2n * Q64, amountIn: 1024n, amountOut: 510n, feeAmount: 2n });
    // Reach the initialized tick with output still left; the replay must cross.
    expect(computeSwapStep(Q64, 2n * Q64, 1024n, 600n, 0n, false, true, false))
      .toEqual({ sqrtPriceNextX64: 2n * Q64, amountIn: 1024n, amountOut: 512n, feeAmount: 0n });
  });

  it("crosses initialized arrays for exact output and refuses an unfillable target", async () => {
    const q = await sdk.quoteBuyExactOutSolana({ rpc: rpcFor("fresh"), mint: MINT, amountOut: 400000000000000n, timestamp: 1n << 40n });
    expect(q.tickArrayStarts.length).toBeGreaterThan(1);
    expect(q.amountOut).toBe(400000000000000n);
    await expect(sdk.quoteBuyExactOutSolana({ rpc: rpcFor("fresh"), mint: MINT, amountOut: 2000000000000000n, timestamp: 1n << 40n }))
      .rejects.toMatchObject({ code: "INSUFFICIENT_LIQUIDITY" });
    await expect(sdk.quoteBuyExactOutSolana({ rpc: rpcFor("fresh"), mint: MINT, amountOut: 400000000000000n, timestamp: 1n << 40n, maxTickArrays: 1 }))
      .rejects.toMatchObject({ code: "QUOTE_UNAVAILABLE" });
  });

  it("registers fee title to the recorded creator and derives migration/admin accounts", async () => {
    const payer = addr(21);
    const launch = launchFixture();
    const launchPda = await sdk.rallyPdas().launch(launch.mint);
    const nft = await sdk.rallyPdas().feeBeneficiary(launchPda);
    const reg = await sdk.prepareRegisterFeeBeneficiary({ payer, mint: launch.mint, launch });
    expect(reg.instructions[0]!.accounts![4]!.address).toBe(launch.creator);
    expect(reg.instructions[0]!.accounts![3]!.address).toBe(nft);
    const escrow = await sdk.prepareSetCreatorClaimEscrow({ governance: payer, escrow: true });
    expect(Array.from(escrow.instructions[0]!.data!).at(-1)).toBe(1);
    const extend = await sdk.prepareExtendAccount({ payer, account: launchPda });
    expect(extend.signers).toEqual([payer]);
    const migrate = await sdk.prepareMigrateReferral({ payer, referrer: addr(22), quoteMint: launch.quoteMint, quoteTokenProgram: sdk.TOKEN_PROGRAM_ADDRESS });
    const referral = await sdk.rallyPdas().referral(launch.quoteMint, addr(22));
    expect(migrate.instructions[0]!.accounts![2]!.address).toBe(await sdk.rallyPdas().referralVault(referral));
  });

  it("pays wallet holders permissionlessly, requires PDA CPI signature and preserves burn fallback", async () => {
    const feeNftMint = await sdk.rallyPdas().feeBeneficiary(await sdk.rallyPdas().launch(base.mint));
    const launch = launchFixture({ feeNftMint });
    const wallet = "HL9t322Rxwpix39LT6os5gATueBvkQVHDuP9L8hNHwdu" as typeof base.mint;
    const build = async (holder: typeof wallet, feeNftAccount: typeof wallet | null) => sdk.prepareClaimCreatorFees({ mint: base.mint, launch, holder, feeNftAccount,
      holderQuoteAccount: await sdk.findAssociatedTokenAddress(holder, launch.quoteMint, sdk.TOKEN_PROGRAM_ADDRESS), quoteTokenProgram: sdk.TOKEN_PROGRAM_ADDRESS });
    const permissionless = await build(wallet, addr(61));
    expect(permissionless.signers).toEqual([]);
    expect(permissionless.instructions[0]!.accounts![7]!.role).toBe(AccountRole.READONLY);
    const pda = await sdk.rallyPdas().config();
    const cpi = await build(pda, addr(61));
    expect(cpi.signers).toEqual([pda]);
    expect(cpi.instructions[0]!.accounts![7]!.role).toBe(AccountRole.READONLY_SIGNER);
    expect((await build(launch.creator,null)).signers).toEqual([]);
    await expect(build(wallet,null)).rejects.toMatchObject({ code: "NO_ACCOUNT" });
    await expect(sdk.prepareClaimCreatorFees({ mint: base.mint, launch, holder: wallet, feeNftAccount: addr(61), holderQuoteAccount: addr(99), quoteTokenProgram: sdk.TOKEN_PROGRAM_ADDRESS }))
      .rejects.toMatchObject({ code: "NO_ACCOUNT" });
    const burnedPdaCreator = await sdk.prepareClaimCreatorFees({ mint: base.mint, launch: { ...launch, creator: pda }, holder: pda, feeNftAccount: null,
      holderQuoteAccount: await sdk.findAssociatedTokenAddress(pda,launch.quoteMint,sdk.TOKEN_PROGRAM_ADDRESS), quoteTokenProgram: sdk.TOKEN_PROGRAM_ADDRESS });
    expect(burnedPdaCreator.signers).toEqual([]);
  });

  it("resolves current holder, rejects spoofed ownership, and detects burned supply", async () => {
    const feeNftMint = await sdk.rallyPdas().feeBeneficiary(await sdk.rallyPdas().launch(base.mint));
    const launch = launchFixture({ feeNftMint });
    const mintData = new W().zeros(36).int(1n,8).u8(0).u8(1).zeros(36).bytes();
    const tokenData = new W().key(feeNftMint).key(addr(20)).int(1n,8).zeros(36).u8(1).zeros(56).bytes();
    const rpc = fakeRpc({ [feeNftMint]: { data: mintData, owner: sdk.TOKEN_2022_PROGRAM_ADDRESS }, [addr(61)]: { data: tokenData, owner: sdk.TOKEN_2022_PROGRAM_ADDRESS } });
    rpc.getTokenLargestAccounts = () => ({ send: async () => ({ value: [{ address: addr(61), amount: "1" }] }) });
    expect(await sdk.fetchFeeBeneficiary(rpc,base.mint,{launch})).toMatchObject({ holder: addr(20), feeNftAccount: addr(61), burned: false });
    const spoofed = fakeRpc({ [feeNftMint]: { data: mintData, owner: sdk.TOKEN_PROGRAM_ADDRESS } });
    await expect(sdk.fetchFeeBeneficiary(spoofed,base.mint,{launch})).rejects.toMatchObject({ code: "INVALID_ACCOUNT_DATA" });
    for (const tamper of [
      (d: Uint8Array) => { d.set(new W().key(addr(99)).bytes(),0); },
      (d: Uint8Array) => { new DataView(d.buffer).setBigUint64(64,0n,true); },
      (d: Uint8Array) => { d[108] = 2; },
    ]) {
      const bad = tokenData.slice();
      tamper(bad);
      const malformed = fakeRpc({ [feeNftMint]: { data: mintData, owner: sdk.TOKEN_2022_PROGRAM_ADDRESS }, [addr(61)]: { data: bad, owner: sdk.TOKEN_2022_PROGRAM_ADDRESS } });
      malformed.getTokenLargestAccounts = rpc.getTokenLargestAccounts;
      await expect(sdk.fetchFeeBeneficiary(malformed,base.mint,{launch})).rejects.toMatchObject({ code: "INVALID_ACCOUNT_DATA" });
    }
    const wrongTokenOwner = fakeRpc({ [feeNftMint]: { data: mintData, owner: sdk.TOKEN_2022_PROGRAM_ADDRESS }, [addr(61)]: { data: tokenData, owner: sdk.TOKEN_PROGRAM_ADDRESS } });
    wrongTokenOwner.getTokenLargestAccounts = rpc.getTokenLargestAccounts;
    await expect(sdk.fetchFeeBeneficiary(wrongTokenOwner,base.mint,{launch})).rejects.toMatchObject({ code: "INVALID_ACCOUNT_DATA" });
    new DataView(mintData.buffer).setBigUint64(36,0n,true);
    expect(await sdk.fetchFeeBeneficiary(rpc,base.mint,{launch})).toMatchObject({ holder: launch.creator, feeNftAccount: null, burned: true });
  });
});
