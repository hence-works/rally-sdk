import { getAddressDecoder, getAddressEncoder, getBase64Decoder, type Address } from "@solana/kit";
import type { LaunchAccount, PositionInfo } from "../../src/solana";

export const dec = getAddressDecoder();
export const enc = getAddressEncoder();
/** A deterministic address from a byte value (32 copies of it). */
export const addr = (b: number): Address => dec.decode(new Uint8Array(32).fill(b));
export const ZERO = addr(0);

/** Sequential little-endian byte writer, laid out field by field from the program's structs. */
export class W {
  parts: number[] = [];
  u8(n: number) {
    this.parts.push(n & 0xff);
    return this;
  }
  int(n: bigint | number, bytes: number) {
    let v = BigInt.asUintN(bytes * 8, BigInt(n));
    for (let i = 0; i < bytes; i++) {
      this.parts.push(Number(v & 0xffn));
      v >>= 8n;
    }
    return this;
  }
  key(a: Address) {
    this.parts.push(...enc.encode(a));
    return this;
  }
  zeros(n: number) {
    this.parts.push(...new Array(n).fill(0));
    return this;
  }
  raw(b: ArrayLike<number>) {
    this.parts.push(...Array.from(b));
    return this;
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    return this.int(b.length, 4).raw(b);
  }
  bytes() {
    return Uint8Array.from(this.parts);
  }
}

const position = (w: W, p: { nft: Address; lo: number; hi: number; liq: bigint; fee: Address }) =>
  w.key(p.nft).int(p.lo, 4).int(p.hi, 4).int(p.liq, 16).key(p.fee);

export const emptyPos = { nft: ZERO, lo: 0, hi: 0, liq: 0n, fee: ZERO };

/** Raw `Launch` account bytes: discriminator then the struct in IDL order. */
export function launchBytes(disc: number[]): Uint8Array {
  const w = new W().raw(disc);
  w.u8(254).u8(253).u8(1).u8(0); // bump, authority_bump, phase = Curve, curve_preset
  w.key(addr(1)).key(addr(2)).key(addr(3)).key(addr(4)).key(addr(5)); // mint creator quote pool amm_config
  w.int(1000, 8).int(1100, 8).int(0, 8); // created_at launched_at broke_out_at
  w.int(-12000, 4).int(24000, 4); // tick_lower tick_upper
  w.int(85_000_000_000n, 8).int(1_000_000_000_000_000n, 8).int(800_000_000_000_000n, 8).int(100n, 8).int(7n, 8);
  w.int(100, 2).int(200, 2).int(300, 2).int(400, 2); // fee_config
  w.int(1, 2).int(2, 2).int(3, 2).int(4, 2); // breakout_fee_config
  w.u8(1); // breakout_split_armed
  w.int(2500, 2).int(100, 2).int(600, 4).int(50, 2).int(25, 2).int(10, 2); // schedule
  w.int(11, 8).int(12, 8).int(13, 8).int(14, 8).int(15, 8); // buckets
  w.u8(2); // num_positions
  for (let i = 0; i < 6; i++) {
    position(w, i < 2 ? { nft: addr(10 + i), lo: -7200 + i * 3600, hi: 3600 * (i + 1), liq: 123456789012345678901234n, fee: ZERO } : emptyPos);
  }
  position(w, emptyPos); // support
  w.int(21, 8).int(22, 8).int(23, 8).int(24, 8).int(25, 8); // support_token_reserve flush_slot flushed dividend_epoch dividend_reserved
  w.int(9, 2); // support_nonce
  w.zeros(128); // reserved
  return w.bytes();
}

const pos = (i: number): PositionInfo => ({
  nftMint: addr(10 + i),
  tickLower: -7200 + i * 3600,
  tickUpper: 3600 * (i + 1),
  liquidity: 1n,
  feeNftMint: ZERO,
});
const none: PositionInfo = { nftMint: ZERO, tickLower: 0, tickUpper: 0, liquidity: 0n, feeNftMint: ZERO };

/** A decoded Launch for the offline (no RPC) prepare* paths. */
export function launchFixture(over: Partial<LaunchAccount> = {}): LaunchAccount {
  return {
    bump: 1,
    authorityBump: 1,
    phase: "Curve",
    curvePreset: 0,
    mint: addr(1),
    creator: addr(2),
    quoteMint: addr(3),
    pool: addr(4),
    ammConfig: addr(5),
    createdAt: 0n,
    launchedAt: 0n,
    brokeOutAt: 0n,
    tickLower: -7200,
    tickUpper: 3600,
    gradThreshold: 85_000_000_000n,
    totalSupply: 0n,
    curveSupply: 0n,
    tailSupply: 0n,
    firstBuyTokens: 0n,
    feeConfig: { creatorBps: 0, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
    breakoutFeeConfig: { creatorBps: 0, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
    breakoutSplitArmed: false,
    schedule: { curveFeeStartBps: 0, curveFeeEndBps: 0, curveFeeDecay: 0, platformBps: 0, creatorCapBps: 0, breakoutCreatorCapBps: 0 },
    buckets: { creator: 0n, dividend: 0n, buyback: 0n, lpSupport: 0n, platform: 0n },
    numPositions: 2,
    positions: [pos(0), pos(1), none, none, none, none],
    support: none,
    supportTokenReserve: 0n,
    flushSlot: 0n,
    flushedInSlot: 0n,
    dividendEpoch: 0n,
    dividendReserved: 0n,
    supportNonce: 0,
    feeNftMint: addr(60),
    feeNftBump: 0,
    ...over,
  };
}

/** A fake kit RPC serving fixed account bytes by address. */
export function fakeRpc(accounts: Record<string, { data: Uint8Array; owner: Address }>) {
  const b64 = getBase64Decoder();
  const one = (a: Address) => {
    const acc = accounts[a];
    return acc
      ? { data: [b64.decode(acc.data), "base64"], owner: acc.owner, lamports: 1n, executable: false, space: BigInt(acc.data.length) }
      : null;
  };
  return {
    getMultipleAccounts: (addrs: Address[]) => ({
      send: async () => ({ context: { slot: 1n }, value: addrs.map(one) }),
    }),
    getAccountInfo: (a: Address) => ({
      send: async () => {
        const acc = accounts[a];
        return { context: { slot: 1n }, value: acc ? { data: [b64.decode(acc.data), "base64"], owner: acc.owner, lamports: 1n, executable: false, space: BigInt(acc.data.length) } : null };
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
