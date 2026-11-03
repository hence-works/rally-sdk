import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "@solana/kit";
import { fakeRpc } from "../fixtures";

const here = dirname(fileURLToPath(import.meta.url));

export interface GoldenFixture {
  meta: { program: string; mint: string };
  firstBuy: {
    firstBuyTokens: string;
    quoteCost: string;
    tokensOut: string;
    programQuoteIn: string;
    programTokensOut: string;
    exactMaxAccepted: boolean;
    oneLessRejected: string;
    oneLessLog: string;
  };
  outsideLiquidityWithoutQuote: { withoutQuoteErr: string };
  snapshots: Record<string, { launch: string; pool: string; accounts: Record<string, { owner: string; data: string }> }>;
  cases: Array<{
    snapshot: string;
    name: string;
    side: "buy" | "sell";
    amountIn: string;
    clock: string;
    expected:
      | { ok: true; quoteAmount: string; tokenAmount: string; fee: string; sqrtPriceX64: string; tick: number }
      | { ok: false; programError: string };
  }>;
}

/** Recorded by `harness.ts` against the deployed program. */
export const fx: GoldenFixture = JSON.parse(readFileSync(join(here, "fixtures/local-validator.json"), "utf8"));
export const MINT = fx.meta.mint as Address;

type Acc = { owner: Address; data: Uint8Array };

/** The recorded accounts of a snapshot, decoded; `mutate` may edit or drop any of them. */
export function accountsOf(snap: string, mutate?: (accounts: Record<string, Acc>) => void): Record<string, Acc> {
  const accounts = Object.fromEntries(
    Object.entries(fx.snapshots[snap]!.accounts).map(([a, v]) => [
      a,
      { owner: v.owner as Address, data: new Uint8Array(gunzipSync(Buffer.from(v.data, "base64"))) },
    ]),
  );
  mutate?.(accounts);
  return accounts;
}

export const rpcFor = (snap: string, mutate?: (accounts: Record<string, Acc>) => void) => fakeRpc(accountsOf(snap, mutate));
