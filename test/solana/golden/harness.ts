/**
 * Golden harness: runs the SDK's own `prepare*` + quote paths against the LIVE Rally Solana
 * program (cloned from devnet into a local validator by `validator.sh`) and records, for each
 * scenario, what the program actually did, next to the pool state it did it against.
 *
 *   test/solana/golden/validator.sh /tmp/ledger &       # wait for it to come up
 *   yarn tsx test/solana/golden/harness.ts              # rewrites fixtures/local-validator.json
 *
 * `golden.test.ts` then replays every recorded case OFFLINE through `quoteBuySolana` /
 * `quoteSellSolana` over the recorded accounts and demands the exact numbers the program emitted.
 * Dev tool: nothing here ships.
 */
import { generateKeyPairSigner, getAddressDecoder, type Address } from "@solana/kit";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOLANA_DEVNET_CHAIN_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  WSOL_MINT,
  createAtaIdempotentInstruction,
  fetchLaunch,
  findAssociatedTokenAddress,
  getSolanaDeployment,
  grindMint,
  prepareBuy,
  prepareCreateLaunch,
  prepareOpenPool,
  prepareSell,
  quoteBuySolana,
  quoteFirstBuy,
  quoteSellSolana,
  rallyPdas,
  type LaunchAccount,
  type SolanaSwapQuote,
} from "../../../src/solana";
import { decodeClmmPool } from "../../../src/solana/clmm-swap";
import {
  airdrop,
  cloneLookupTable,
  decodeFirstBuy,
  decodeRallySwap,
  openOutsidePosition,
  rpc,
  send,
  simulate,
  syncNative,
  systemTransfer,
  transferChecked,
} from "./lib";

const here = dirname(fileURLToPath(import.meta.url));
const dep = getSolanaDeployment(SOLANA_DEVNET_CHAIN_ID)!;
const CLMM = dep.raydiumClmm as Address;
const toAddress = (b: Uint8Array) => getAddressDecoder().decode(b);
const balanceOf = async (a: Address) => BigInt((await rpc.getTokenAccountBalance(a).send()).value.amount);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const J = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

interface Account {
  owner: string;
  data: string; // gzip + base64
}
interface Snapshot {
  launch: string;
  pool: string;
  accounts: Record<string, Account>;
}
interface Case {
  snapshot: string;
  name: string;
  side: "buy" | "sell";
  amountIn: string;
  /** Cluster time the program ran the swap at. */
  clock: string;
  /** What the program did, or why it refused. */
  expected:
    | { ok: true; quoteAmount: string; tokenAmount: string; fee: string; sqrtPriceX64: string; tick: number }
    | { ok: false; programError: string };
}

const snapshots: Record<string, Snapshot> = {};
const cases: Case[] = [];

async function raw(addr: Address): Promise<{ owner: string; data: Uint8Array } | null> {
  const r = await rpc.getAccountInfo(addr, { encoding: "base64" }).send();
  if (!r.value) return null;
  return { owner: r.value.owner, data: new Uint8Array(Buffer.from(r.value.data[0], "base64")) };
}

async function snapshot(id: string, mint: Address): Promise<LaunchAccount> {
  const launchPda = await rallyPdas().launch(mint);
  const launch = await fetchLaunch(rpc, mint);
  const accounts: Record<string, Account> = {};
  const put = async (a: Address) => {
    const x = await raw(a);
    if (!x) throw new Error(`snapshot: ${a} missing`);
    accounts[a] = { owner: x.owner, data: gzipSync(x.data).toString("base64") };
    return x;
  };
  await put(launchPda);
  const pool = decodeClmmPool((await put(launch.pool)).data, toAddress);
  await put(launch.ammConfig);
  const { raydiumPdas } = await import("../../../src/solana");
  const ray = raydiumPdas(CLMM);
  for (let bit = 0; bit < 1024; bit++) {
    if (((pool.tickArrayBitmap >> BigInt(bit)) & 1n) === 1n) {
      await put(await ray.tickArray(launch.pool, (bit - 512) * 3600));
    }
  }
  snapshots[id] = { launch: launchPda, pool: launch.pool, accounts };
  return launch;
}

async function main() {
  const creator = await generateKeyPairSigner();
  await airdrop(creator.address, 5000);
  const LUT = await cloneLookupTable(dep.lookupTable as Address, creator);
  const target = { chainId: SOLANA_DEVNET_CHAIN_ID, rpc };
  const mint = await grindMint(WSOL_MINT);
  const wsolAta = await findAssociatedTokenAddress(creator.address, WSOL_MINT, TOKEN_PROGRAM_ADDRESS);
  const tokenAta = await findAssociatedTokenAddress(creator.address, mint.address, TOKEN_2022_PROGRAM_ADDRESS);

  await send(
    [
      await createAtaIdempotentInstruction(creator, creator.address, WSOL_MINT, TOKEN_PROGRAM_ADDRESS),
      systemTransfer(creator, wsolAta, 3000_000_000_000n),
      syncNative(wsolAta, TOKEN_PROGRAM_ADDRESS),
    ],
    creator,
  );

  // ── launch with a first buy: the exactness proof for quoteFirstBuy ──
  const S = 1_000_000_000_000_000n;
  const firstBuyTokens = S / 100n;
  const fb = await quoteFirstBuy({ rpc, mint: mint.address, quoteMint: WSOL_MINT, curvePreset: 0, firstBuyTokens });
  const create = await prepareCreateLaunch({
    ...target,
    creator,
    mint: mint.signer,
    quoteMint: WSOL_MINT,
    name: "Golden",
    symbol: "GLD",
    metadataUri: "https://example.com/golden.json",
    curvePreset: 0,
    firstBuyTokens,
  });
  await send(create.instructions, creator);
  const created = await fetchLaunch(rpc, mint.address);
  const open = async (max: bigint) => prepareOpenPool({ ...target, creator, mint: mint.address, launch: created, maxFirstBuyQuote: max });
  const tooLow = await simulate((await open(fb.quoteCost - 1n)).instructions, creator, LUT);
  const exact = await simulate((await open(fb.quoteCost)).instructions, creator, LUT);
  const ev = decodeFirstBuy(exact.events.find((e) => e.name === "FirstBuy")!.data);
  const firstBuyRecord = {
    firstBuyTokens: firstBuyTokens.toString(),
    quoteCost: fb.quoteCost.toString(),
    tokensOut: fb.tokensOut.toString(),
    programQuoteIn: ev.quoteIn.toString(),
    programTokensOut: ev.tokensOut.toString(),
    exactMaxAccepted: exact.err === null,
    oneLessRejected: J(tooLow.err),
    oneLessLog: tooLow.logs.find((l) => l.includes("FirstBuySlippage")) ?? null,
  };
  console.log("first buy:", firstBuyRecord);
  await send((await open(fb.quoteCost)).instructions, creator, LUT);

  // ── recording ──
  const sims = async (
    snap: string,
    label: string,
    side: "buy" | "sell",
    sizes: bigint[],
    mkLaunch: () => Promise<LaunchAccount>,
  ) => {
    for (const amt of sizes) {
      const launch = await mkLaunch();
      let quote: SolanaSwapQuote | undefined;
      let quoteErr: unknown;
      try {
        quote = await (side === "buy" ? quoteBuySolana : quoteSellSolana)({ rpc, mint: mint.address, amountIn: amt, slippageBps: 100, launch });
      } catch (e) {
        quoteErr = e;
      }
      // Build the instruction with whatever the quote says; if it refused, fall back to a 1-unit bound.
      const tx = await (side === "buy" ? prepareBuy : prepareSell)({
        ...target,
        trader: creator,
        mint: mint.address,
        launch,
        amountIn: amt,
        ...(quote ? { quote, slippageBps: 100 } : { minOut: 1n }),
        deadline: 99_999_999_999n,
      });
      const sim = await simulate(tx.instructions, creator, LUT);
      const e = sim.events.find((x) => x.name === "RallySwap");
      const name = `${label} ${side} ${amt}`;
      if (sim.err === null && e) {
        const d = decodeRallySwap(e.data);
        cases.push({
          snapshot: snap,
          name,
          side,
          amountIn: amt.toString(),
          clock: sim.clock.toString(),
          expected: { ok: true, quoteAmount: d.quoteAmount.toString(), tokenAmount: d.tokenAmount.toString(), fee: d.fee.toString(), sqrtPriceX64: d.sqrtPriceX64.toString(), tick: d.tick },
        });
        const mine = quote
          ? side === "buy"
            ? [quote.amountInUsed, quote.amountOut]
            : [quote.amountOut, quote.amountInUsed]
          : null;
        console.log(`${name} @${sim.clock}: program q=${d.quoteAmount} t=${d.tokenAmount} fee=${d.fee} tick=${d.tick} | quote ${mine ? `q/t=${mine[0]}/${mine[1]} fee=${quote!.fees.routerFee} tick=${quote!.endTick} (quote ts ${quote!.timestamp})` : `REFUSED ${String(quoteErr)}`}`);
      } else {
        const code = sim.logs.find((l) => /Error Code|custom program error/.test(l)) ?? J(sim.err);
        cases.push({ snapshot: snap, name, side, amountIn: amt.toString(), clock: sim.clock.toString(), expected: { ok: false, programError: code } });
        console.log(`${name}: program refused: ${code} | quote ${quote ? "OK(!)" : `refused: ${String(quoteErr)}`}`);
      }
    }
  };
  const SOL = 1_000_000_000n;
  const buySizes = [1n, 999n, 5_000n, 1_000_000n, 77_777_777n, SOL, 5n * SOL, 20n * SOL];
  const sellSizes = [1n, 1_000n, 123_456_789n, 1_000_000_000n, 1_000_000_000_000n, 5_000_000_000_000n];

  // Snapshot 1: fresh pool, the anti-snipe fee is high and decaying. Several clock readings.
  const live = () => fetchLaunch(rpc, mint.address);
  const s1 = await snapshot("fresh", mint.address);
  await sims("fresh", "t0", "buy", [1_000_000n, SOL, 20n * SOL], async () => s1);
  await sims("fresh", "t0", "sell", [1_000_000_000_000n], async () => s1);
  for (const wait of [7000, 9000, 9000]) {
    await sleep(wait);
    await sims("fresh", "decay", "buy", [SOL, 20n * SOL], async () => s1);
    await sims("fresh", "decay", "sell", [1_000_000_000_000n], async () => s1);
  }
  await sleep(12000);
  await sims("fresh", "settled", "buy", buySizes, async () => s1);
  await sims("fresh", "settled", "sell", sellSizes, async () => s1);
  // Cross the boundary between the curve position and the tail: more than B of spendable quote.
  await sims("fresh", "cross", "buy", [90n * SOL, 100n * SOL, 300n * SOL], async () => s1);

  // Snapshot 2: after a real buy, the price sits mid-array.
  const q2 = await quoteBuySolana({ rpc, mint: mint.address, amountIn: 5n * SOL, slippageBps: 100 });
  await send((await prepareBuy({ ...target, trader: creator, mint: mint.address, quote: q2, slippageBps: 100 })).instructions, creator, LUT);
  const s2 = await snapshot("moved", mint.address);
  await sims("moved", "moved", "buy", [SOL, 30n * SOL, 100n * SOL], async () => s2);
  const held2 = await balanceOf(tokenAta);
  await sims("moved", "moved", "sell", [1_000_000_000_000n, held2 / 2n, held2], async () => s2);

  // Snapshot 3: somebody who is not the launch has added liquidity, in arrays the launch's own
  // positions never touch. A quote built from the launch's positions alone gets this wrong.
  // What the pre-quote path did with outside liquidity: it only passes arrays the launch's own positions touch.
  const lp = await generateKeyPairSigner();
  await airdrop(lp.address, 1000);
  const lpWsol = await findAssociatedTokenAddress(lp.address, WSOL_MINT, TOKEN_PROGRAM_ADDRESS);
  const lpTok = await findAssociatedTokenAddress(lp.address, mint.address, TOKEN_2022_PROGRAM_ADDRESS);
  await send(
    [
      await createAtaIdempotentInstruction(lp, lp.address, WSOL_MINT, TOKEN_PROGRAM_ADDRESS),
      await createAtaIdempotentInstruction(lp, lp.address, mint.address, TOKEN_2022_PROGRAM_ADDRESS),
      systemTransfer(lp, lpWsol, 200n * SOL),
      syncNative(lpWsol, TOKEN_PROGRAM_ADDRESS),
      transferChecked({ source: tokenAta, mint: mint.address, dest: lpTok, owner: creator, amount: 6_000_000_000_000n, decimals: 6, program: TOKEN_2022_PROGRAM_ADDRESS }),
    ],
    lp,
  );
  const mkPos = async (lo: number, hi: number, liquidity: bigint) => {
    const nft = await generateKeyPairSigner();
    await send(
      [
        await openOutsidePosition({ lp, nftMint: nft, clmm: CLMM, pool: s2.pool, mint0: mint.address, mint1: WSOL_MINT, tickLower: lo, tickUpper: hi, liquidity, lpToken0: lpTok, lpToken1: lpWsol }),
      ],
      lp,
    );
  };
  // Straddling the current price, inside the launch's own array; and two ranges up the curve in arrays of their own.
  const tick = decodeClmmPool((await raw(s2.pool))!.data, toAddress).tickCurrent;
  console.log("pool tick before outside LP:", tick);
  await mkPos(Math.floor(tick / 60) * 60 - 120, Math.floor(tick / 60) * 60 + 180, 200_000_000_000n);
  await mkPos(-97200, -90060, 50_000_000_000n);
  await mkPos(-86400, -75360, 30_000_000_000n);
  const s3 = await snapshot("outside-lp", mint.address);
  const legacy = await simulate(
    (await prepareBuy({ ...target, trader: creator, mint: mint.address, launch: s2, amountIn: 30n * SOL, minOut: 1n, deadline: 99_999_999_999n })).instructions,
    creator,
    LUT,
  );
  const legacyRecord = { withoutQuoteErr: J(legacy.err), log: legacy.logs.find((l) => /Error Code/.test(l)) ?? null };
  console.log("30 SOL buy WITHOUT the quote's arrays, outside LP present:", legacyRecord);

  await sims("outside-lp", "lp", "buy", [SOL, 10n * SOL, 30n * SOL, 60n * SOL, 100n * SOL, 200n * SOL], async () => s3);
  const held3 = await balanceOf(tokenAta);
  await sims("outside-lp", "lp", "sell", [1_000_000_000_000n, held3 / 3n, held3], async () => s3);

  // Snapshot 4: breakout. Fee is zero from here; the price is in the tail, and a sell walks back down through the boundary.
  const q4 = await quoteBuySolana({ rpc, mint: mint.address, amountIn: 160n * SOL, slippageBps: 100 });
  console.log("breakout buy quote ends at tick", q4.endTick, "arrays", q4.tickArrayStarts);
  await send((await prepareBuy({ ...target, trader: creator, mint: mint.address, quote: q4, slippageBps: 100 })).instructions, creator, LUT);
  const s4 = await snapshot("breakout", mint.address);
  const l4 = await live();
  console.log("phase after:", l4.phase);
  await sims("breakout", "post", "buy", [1n, 1_000_000n, SOL, 50n * SOL], async () => l4);
  const held4 = await balanceOf(tokenAta);
  await sims("breakout", "post", "sell", [1_000n, 1_000_000_000_000n, held4 / 2n, held4], async () => l4);

  mkdirSync(join(here, "fixtures"), { recursive: true });
  writeFileSync(
    join(here, "fixtures", "local-validator.json"),
    JSON.stringify(
      {
        meta: {
          program: dep.rallySolanaProtocol,
          raydiumClmm: CLMM,
          source: "test/solana/golden/harness.ts against the devnet-deployed program, cloned into a local validator",
          mint: mint.address,
        },
        firstBuy: firstBuyRecord,
        outsideLiquidityWithoutQuote: legacyRecord,
        snapshots,
        cases,
      },
      null,
      1,
    ),
  );
  console.log(`wrote ${cases.length} cases`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
