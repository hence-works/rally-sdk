import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RALLY_SOLANA_PROTOCOL_PROGRAM_ID,
  RallyError,
  decodeConfig,
  decodeLaunch,
  decodePoolSlot0,
  decodeQuoteConfig,
  decodeReferral,
  fetchClusterTime,
  fetchLaunch,
  fetchLaunchPriceWad,
  rallyPdas,
} from "../../src/solana";
import { CLOCK_SYSVAR_ADDRESS } from "../../src/solana";
import { W, ZERO, addr, fakeRpc, launchBytes } from "./fixtures";

/** Anchor: account discriminator = sha256("account:<Name>")[0..8]. */
const disc = (name: string) => [...createHash("sha256").update(`account:${name}`).digest().subarray(0, 8)];

describe("Launch decoding", () => {
  const launch = decodeLaunch(launchBytes(disc("Launch")));
  it("reads fields at the program's offsets", () => {
    expect(launch.phase).toBe("Curve");
    expect(launch.mint).toBe(addr(1));
    expect(launch.creator).toBe(addr(2));
    expect(launch.quoteMint).toBe(addr(3));
    expect(launch.pool).toBe(addr(4));
    expect(launch.ammConfig).toBe(addr(5));
    expect(launch.tickLower).toBe(-12000);
    expect(launch.tickUpper).toBe(24000);
    expect(launch.gradThreshold).toBe(85_000_000_000n);
    expect(launch.totalSupply).toBe(1_000_000_000_000_000n);
    expect(launch.firstBuyTokens).toBe(7n);
    expect(launch.feeConfig).toEqual({ creatorBps: 100, dividendBps: 200, buybackBps: 300, lpSupportBps: 400 });
    expect(launch.breakoutSplitArmed).toBe(true);
    expect(launch.schedule.curveFeeDecay).toBe(600);
    expect(launch.buckets).toEqual({ creator: 11n, dividend: 12n, buyback: 13n, lpSupport: 14n, platform: 15n });
    expect(launch.numPositions).toBe(2);
    expect(launch.positions).toHaveLength(6);
    expect(launch.positions[1]).toMatchObject({ nftMint: addr(11), tickLower: -3600, tickUpper: 7200 });
    expect(launch.positions[0]!.liquidity).toBe(123456789012345678901234n); // u128 survives
    expect(launch.dividendReserved).toBe(25n);
    expect(launch.supportNonce).toBe(9);
  });
  it("keeps u64 values as bigint and drops reserved padding", () => {
    expect(typeof launch.gradThreshold).toBe("bigint");
    expect("reserved" in launch).toBe(false);
  });
  it("refuses another account type's bytes", () => {
    expect(() => decodeLaunch(launchBytes(disc("QuoteConfig")))).toThrow(/discriminator/);
    expect(() => decodeLaunch(new Uint8Array(4))).toThrow(RallyError);
  });
  it("refuses truncated data", () => {
    expect(() => decodeLaunch(launchBytes(disc("Launch")).subarray(0, 300))).toThrow(RallyError);
  });
});

describe("QuoteConfig / Config / ReferralAccount decoding", () => {
  it("QuoteConfig", () => {
    const w = new W().raw(disc("QuoteConfig")).u8(255).u8(254).key(addr(1)).key(addr(2)).key(addr(3));
    w.u8(9).u8(1).int(85_000_000_000n, 8).int(500_000_000n, 8).key(addr(4)).key(ZERO).int(77, 8).int(88, 8).zeros(64);
    const q = decodeQuoteConfig(w.bytes());
    expect(q).toMatchObject({
      mint: addr(1),
      vault: addr(2),
      tokenProgram: addr(3),
      decimals: 9,
      enabled: true,
      gradThreshold: 85_000_000_000n,
      launchFee: 500_000_000n,
      ammConfig: addr(4),
      dynamicFeeConfig: ZERO,
      treasuryOwed: 77n,
      referralOwed: 88n,
    });
  });
  it("Config", () => {
    const w = new W().raw(disc("Config")).u8(1).key(addr(1)).key(addr(2)).key(addr(3)).key(addr(4));
    w.u8(0).u8(1).u8(0).u8(1);
    for (let i = 0; i < 24; i++) w.int(i * 10, 8);
    for (let i = 0; i < 24; i++) w.int(i, 8).int(-i, 8);
    w.int(1, 2).int(2, 2).int(3, 2).int(4, 2).int(5, 2).int(6, 2).int(7, 2).int(8, 2).int(42, 8).zeros(128);
    const c = decodeConfig(w.bytes());
    expect(c.governance).toBe(addr(1));
    expect(c.treasury).toBe(addr(3));
    expect(c.creatorClaimEscrow).toBe(true);
    expect(c.raydiumLockEnabled).toBe(true);
    expect(c.params[23]).toBe(230n);
    expect(c.pending[5]).toEqual({ value: 5n, eta: -5n });
    expect(c.defaultBreakoutFeeConfig.lpSupportBps).toBe(8);
    expect(c.launchCount).toBe(42n);
  });
  it("ReferralAccount", () => {
    const w = new W().raw(disc("ReferralAccount")).u8(3).key(addr(1)).key(addr(2)).int(5, 8).int(9, 8);
    expect(decodeReferral(w.bytes())).toEqual({ bump: 3, referrer: addr(1), quoteMint: addr(2), owed: 5n, earned: 9n, vault: ZERO, vaultBump: 0 });
    expect(decodeReferral(w.key(addr(7)).u8(250).zeros(63).bytes())).toMatchObject({ vault: addr(7), vaultBump: 250, owed: 5n });
    for (const length of [0, 8, 88, 90, 120, 184]) {
      expect(() => decodeReferral(w.bytes().subarray(0,length))).toThrow(RallyError);
    }
  });
});

describe("Raydium pool state", () => {
  it("reads sqrt_price_x64 (u128) at 253 and tick_current (i32) at 269", () => {
    const d = new Uint8Array(1544);
    const dv = new DataView(d.buffer);
    dv.setBigUint64(253, 0x1122334455667788n, true);
    dv.setBigUint64(261, 0x99n, true);
    dv.setInt32(269, -12345, true);
    expect(decodePoolSlot0(d)).toEqual({ sqrtPriceX64: (0x99n << 64n) | 0x1122334455667788n, tick: -12345 });
  });
  it("rejects a short account", () => {
    expect(() => decodePoolSlot0(new Uint8Array(100))).toThrow(RallyError);
  });
});

describe("fetch helpers", () => {
  it("fetchLaunchPriceWad fails closed without both mints", async () => {
    await expect(fetchLaunchPriceWad(fakeRpc({}), { pool: addr(1) } as never, 9)).rejects.toMatchObject({ code: "MISSING_ADDRESS" });
  });

  it("fetchLaunch checks the owner program", async () => {
    const mint = addr(1);
    const at = await rallyPdas(RALLY_SOLANA_PROTOCOL_PROGRAM_ID).launch(mint);
    const data = launchBytes(disc("Launch"));
    const ok = fakeRpc({ [at]: { data, owner: RALLY_SOLANA_PROTOCOL_PROGRAM_ID } });
    expect((await fetchLaunch(ok, mint)).creator).toBe(addr(2));
    const spoofed = fakeRpc({ [at]: { data, owner: addr(9) } });
    await expect(fetchLaunch(spoofed, mint)).rejects.toThrow(/owned by/);
    await expect(fetchLaunch(fakeRpc({}), mint)).rejects.toMatchObject({ code: "LAUNCH_NOT_FOUND" });
  });
  it("fetchClusterTime reads unix_timestamp from the Clock sysvar", async () => {
    const clock = new W().int(5, 8).int(0, 8).int(1, 8).int(1, 8).int(1_700_000_000n, 8).bytes();
    const rpc = fakeRpc({ [CLOCK_SYSVAR_ADDRESS]: { data: clock, owner: addr(7) } });
    expect(await fetchClusterTime(rpc)).toBe(1_700_000_000n);
  });
});
