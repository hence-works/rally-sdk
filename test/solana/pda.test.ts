/**
 * Golden values computed with the REFERENCE client's own derivation
 * (`packages/rally-solana/ts/src/client.ts`: web3.js `findProgramAddressSync` with its
 * seeds, spl-token `getAssociatedTokenAddressSync`), over fixed inputs. A wrong seed order,
 * endianness or width yields a plausible address, so these pin every PDA the SDK derives.
 */
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenAddress,
  rallyPdas,
  raydiumPdas,
  tickArrayStart,
} from "../../src/solana";

const PROGRAM = address("7mdwZfoJm6iXj3hWsqsbeqExJV6SZ3EYQWnBqGmKGz76");
const CLMM = address("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const QUOTE = address("So11111111111111111111111111111111111111112");
const REFERRER = address("Vote111111111111111111111111111111111111111");
const AMM = address("CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu");

describe("rally program PDAs", () => {
  const p = rallyPdas(PROGRAM);
  it("match the reference client", async () => {
    expect(await p.config()).toBe("2r9T3zLRmYtxvyRUBr6yNXs5xe8tRuFYxqgwevuCx9ZR");
    expect(await p.quoteConfig(QUOTE)).toBe("7E2ipAXfWjX27tHhAYG5JXcguGTdVStB8W1fWyDmFXdE");
    expect(await p.quoteVault(QUOTE)).toBe("9sgNggenhpurB6ZbMfu3tUB5dfXQPBvNTSyveZTrxWdA");
    const launch = await p.launch(MINT);
    expect(launch).toBe("2X77BB6M5UEqs3FHsSjf9gH2oqnCP5G8YceYtML8REk8");
    expect(await p.authority(launch)).toBe("JDMSXChSSFqJHh4t3m2GA3EbFuuPfW1dGx43RdLtSj3k");
    expect(await p.positionNft(launch, 2)).toBe("8QwCGDLnggRrFfAjarGQEBegXviHWqp5gSUwWhA6kPnH");
    expect(await p.supportNft(launch, 7)).toBe("4XchVJcjuXgqJJLzYimixuuWFkNj9esZMKx8MP7ehntc");
    expect(await p.referral(QUOTE, REFERRER)).toBe("AjnnSJH1xZ8Vx9jA3uZLgrUJ68qwZRJoJGhWu51cWErG");
    expect(await p.dividend(launch, 9)).toBe("CQVvZbggh8BaZF8WLdHUbxK1LHjGLgG8TAgjYzrc4cCQ");
    expect(await p.dividendClaim(launch, 300)).toBe("B27HRvDd8XwjvETZbbY3fiydoFM13nwJmraSgnFP4vZV");
    expect(await p.eventAuthority()).toBe("BZATvEeD3VhQa7ztiiQU5sdrz5NY4hCoMNAmD1fAwVE9");
  });
});

describe("raydium PDAs", () => {
  const r = raydiumPdas(CLMM);
  it("match the reference client, including a negative tick array start (big-endian i32)", async () => {
    const pool = await r.pool(AMM, MINT, QUOTE, 1);
    expect(pool).toBe("3joNEohBvpPyY2hJJZeFEfB3Q8KsEbTmnqQGwZprpqwx");
    expect(await r.poolVault(pool, MINT)).toBe("6R1r9o1dVj2NLzfUH7jfs2A6iwo4t5y9a19J52ZUU8U2");
    expect(await r.observation(pool)).toBe("Fv8hjrSkUDfr2EDGXZStaDW6ks7Y5zVGTnEnQXtcTV1y");
    expect(await r.bitmap(pool)).toBe("AE7YcxyxKUCXHCPn7PwC6wDcL9q2DyYB4rxN4XZRuXtG");
    expect(await r.tickArray(pool, -7200)).toBe("DAPzLG31VgFzv91kkvoq4nGSd8eyxDsYRdhNBtaN5dpL");
    expect(await r.tickArray(pool, 10800)).toBe("BLLdo13iyPmyCWrDu2cpQ98KQtbfiha4efDAnFyt8idr");
    const nft = await rallyPdas(PROGRAM).positionNft(await rallyPdas(PROGRAM).launch(MINT), 2);
    expect(await r.personalPosition(nft)).toBe("5Gtyp57G7JdNbjm1cEw2Ae3R5oYJKNFhQmmVD2QqzaJU");
  });
});

describe("associated token addresses", () => {
  it("match spl-token for a PDA owner under Token-2022 and an off-curve owner under Token", async () => {
    const authority = address("JDMSXChSSFqJHh4t3m2GA3EbFuuPfW1dGx43RdLtSj3k");
    expect(await findAssociatedTokenAddress(authority, MINT, TOKEN_2022_PROGRAM_ADDRESS)).toBe(
      "E58KDGugS5mACBke6tqBA74YLqte4Ns4S8NgggyXWK12",
    );
    expect(await findAssociatedTokenAddress(REFERRER, QUOTE, TOKEN_PROGRAM_ADDRESS)).toBe(
      "DDMpR5WTuhhpMbAHpuPdoQcuUHCFCgTucopoLz69YWck",
    );
  });
});

describe("tickArrayStart", () => {
  it("floors to a 3600 tick span, toward negative infinity", () => {
    expect(tickArrayStart(0)).toBe(0);
    expect(tickArrayStart(3599)).toBe(0);
    expect(tickArrayStart(3600)).toBe(3600);
    expect(tickArrayStart(-1)).toBe(-3600);
    expect(tickArrayStart(-3600)).toBe(-3600);
    expect(tickArrayStart(-3601)).toBe(-7200);
  });
});
