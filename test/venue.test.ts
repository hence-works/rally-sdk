/**
 * The universal router's route fee, and the calldata the venue helpers build.
 *
 * The fee maths is what this mostly pins, because getting it backwards is silent rather
 * than loud: an exact-input buy quoted on the trader's gross overstates the output by
 * the fee, and the floor derived from it reverts every trade. The direction was
 * confirmed against the deployed contract on chain 4663, where a 1e15 wei budget at
 * 20 bps hands the venue exactly 998000000000000, so these numbers are the contract's
 * and not a restatement of the implementation.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address } from "viem";
import { rallyUniversalRouterAbi } from "../src/abis";
import { RallyError } from "../src/errors";
import {
  VENUE_KINDS,
  grossForNetRouteFee,
  netOfRouteFee,
  prepareVenueSwapCurve,
  prepareVenueSwapRoute,
  prepareVenueSwapV3,
  prepareVenueSwapV4,
  routeLegCurve,
  routeLegV2,
  routeLegV3,
  routeLegV4,
  venueApprovalFor,
} from "../src/venue";
import type { RallyAddresses } from "../src/types";

const ROUTER: Address = "0xec22403fBa0dADc562CD98a6B2C5FFcfC19A5634";
const RESOLVER: Address = "0x1Ee3dB2590bfc1732C4617C0cDbc92399Df5AEC5";
const POOL: Address = "0x09cfE840c0352311B1b7f3f2faC400376F5dF63B";
const TOKEN: Address = "0x29ad28dd0db0Fb84a348a2B6B5feeCDCe5290D33";
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const VENUE_HOOK: Address = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
/** The wETH/<stock> conversion pool a route hops through. Pinned, never discovered. */
const HOP_POOL: Address = "0x4Cf3A4B0aab4dbbB1C9e4B5C2b0e0e0a3B8f7E21";
const PAIR: Address = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const ADDRESSES = {
  chainId: 4663,
  deploymentBlock: 0,
  weth: WETH,
  usdc: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  poolManager: MANAGER,
  paramRegistry: "0xF7087414ED0ffcbe67f2473889759a678d5F8EEf",
  launchLib: "0xDca540B05164BEB564602a7DF602DD58999c2662",
  launchHook: "0x630501Fb54f9aDC3a1a11730e6e44A0389Bd68cC",
  rallyRouter: "0x1176C7E905F4255d48113d83026AB09334B8b632",
  rallyUniversalRouter: ROUTER,
  ponsV2CurveResolver: RESOLVER,
} satisfies RallyAddresses;

const NO_ROUTER = { ...ADDRESSES, rallyUniversalRouter: undefined } satisfies RallyAddresses;

describe("route fee", () => {
  it("takes the fee by subtraction, matching the deployed contract", () => {
    // The exact figure a 0.001 ETH exact-in buy hands the venue at 20 bps, read off a
    // simulated swapV3 on chain 4663.
    expect(netOfRouteFee(1_000_000_000_000_000n, 20)).toBe(998_000_000_000_000n);
  });

  it("is a no-op while the fee is switched off", () => {
    expect(netOfRouteFee(12_345n, 0)).toBe(12_345n);
    expect(grossForNetRouteFee(12_345n, 0)).toBe(12_345n);
  });

  it("round-trips: grossing a net back up covers the fee", () => {
    for (const bps of [1, 5, 20, 25]) {
      for (const net of [1n, 999n, 1_000_000_000_000_000n, 10n ** 24n]) {
        const gross = grossForNetRouteFee(net, bps);
        // The gross must leave AT LEAST the net once the router takes its cut, or an
        // exact-output fill would be short and revert.
        expect(netOfRouteFee(gross, bps)).toBeGreaterThanOrEqual(net);
      }
    }
  });

  it("rounds the gross up, never down", () => {
    // 1000 net at 20 bps needs 1002.004..., so the ceiling is 1003 rather than 1002.
    const gross = grossForNetRouteFee(1000n, 20);
    expect(gross).toBe(1003n);
    expect(netOfRouteFee(gross, 20)).toBeGreaterThanOrEqual(1000n);
  });

  it("does not lose the fee to truncation on dust", () => {
    // Below the point where bps rounds to a whole wei the fee is zero, which is the
    // contract's behaviour too: `_feeOf` floors.
    expect(netOfRouteFee(100n, 20)).toBe(100n);
  });
});

describe("venue swap calldata", () => {
  it("swapV3 passes the pool through, not a path", () => {
    const req = prepareVenueSwapV3(ADDRESSES, POOL, {
      token: TOKEN,
      buy: true,
      exactIn: true,
      amount: 1_000_000_000_000_000n,
      amountLimit: 42n,
      deadline: 1788598810n,
      value: 1_000_000_000_000_000n,
    });
    expect(req.to).toBe(ROUTER);
    expect(req.chainId).toBe(4663);
    // A native buy attaches the budget, and the router requires it to EQUAL the amount.
    expect(req.value).toBe(1_000_000_000_000_000n);
    const { functionName, args } = decodeFunctionData({
      abi: rallyUniversalRouterAbi,
      data: req.data,
    });
    expect(functionName).toBe("swapV3");
    expect(args).toEqual([
      POOL,
      TOKEN,
      true,
      true,
      1_000_000_000_000_000n,
      42n,
      true,
      1788598810n,
    ]);
  });

  it("swapCurve takes the RESOLVER, so a caller cannot name a curve", () => {
    const req = prepareVenueSwapCurve(ADDRESSES, RESOLVER, {
      token: TOKEN,
      buy: false,
      amountIn: 5n,
      minOut: 1n,
      deadline: 99n,
    });
    const { functionName, args } = decodeFunctionData({
      abi: rallyUniversalRouterAbi,
      data: req.data,
    });
    expect(functionName).toBe("swapCurve");
    expect(args[0]).toBe(RESOLVER);
    // A sell attaches nothing.
    expect(req.value).toBe(0n);
  });

  it("swapV4 defaults the price limit per direction, never to zero", () => {
    const key = {
      currency0: WETH,
      currency1: TOKEN,
      fee: 3000,
      tickSpacing: 60,
      hooks: VENUE_HOOK,
    };
    const zeroForOne = prepareVenueSwapV4(ADDRESSES, {
      manager: MANAGER,
      key,
      token: TOKEN,
      zeroForOne: true,
      amountSpecified: -100n,
      amountLimit: 1n,
      deadline: 99n,
    });
    const a = decodeFunctionData({ abi: rallyUniversalRouterAbi, data: zeroForOne.data });
    expect(a.args[3]).toMatchObject({
      zeroForOne: true,
      amountSpecified: -100n,
      sqrtPriceLimitX96: 4295128740n,
    });

    const oneForZero = prepareVenueSwapV4(ADDRESSES, {
      manager: MANAGER,
      key,
      token: TOKEN,
      zeroForOne: false,
      amountSpecified: 100n,
      amountLimit: 1n,
      deadline: 99n,
    });
    const b = decodeFunctionData({ abi: rallyUniversalRouterAbi, data: oneForZero.data });
    expect(b.args[3]).toMatchObject({
      sqrtPriceLimitX96: 1461446703485210103287273052203988822378723970341n,
    });
  });

  it("approves the ROUTER, and only for an ERC-20 input", () => {
    expect(venueApprovalFor(ADDRESSES, null, 1n)).toBeNull();
    // A native leg is spelled as the zero address on v4 and needs no allowance.
    expect(
      venueApprovalFor(ADDRESSES, "0x0000000000000000000000000000000000000000", 1n),
    ).toBeNull();
    const approval = venueApprovalFor(ADDRESSES, TOKEN, 7n);
    expect(approval?.to).toBe(TOKEN);
    expect(approval?.data.startsWith("0x095ea7b3")).toBe(true);
    // The spender is the router: this path uses no Permit2 and has no second leg.
    expect(approval?.data.toLowerCase()).toContain(ROUTER.slice(2).toLowerCase());
  });
});

describe("route legs", () => {
  it("pins the VenueKind ordinals, which are append-only ABI numbers", () => {
    // These go on the wire. Renumbering one re-points every live route builder at a
    // different venue family, silently, so the table is pinned here as well as in the
    // Solidity enum.
    expect(VENUE_KINDS).toEqual({ V2: 0, V3: 1, V4: 2, CURVE: 3 });
  });

  it("zeroes the fields a shape does not use, which the tuple still has to carry", () => {
    const emptyKey = {
      currency0: ZERO,
      currency1: ZERO,
      fee: 0,
      tickSpacing: 0,
      hooks: ZERO,
    };
    expect(routeLegV3(POOL)).toEqual({
      kind: 1,
      venue: POOL,
      manager: ZERO,
      key: emptyKey,
    });
    expect(routeLegV2(PAIR)).toEqual({ kind: 0, venue: PAIR, manager: ZERO, key: emptyKey });
    expect(routeLegCurve(RESOLVER)).toEqual({
      kind: 3,
      venue: RESOLVER,
      manager: ZERO,
      key: emptyKey,
    });
    // A v4 leg is the mirror image: the pool lives in `manager` + `key`, and `venue` is
    // the field that goes unused.
    const key = { currency0: WETH, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: VENUE_HOOK };
    expect(routeLegV4(MANAGER, key)).toEqual({ kind: 2, venue: ZERO, manager: MANAGER, key });
  });

  it("hands out a fresh key per leg, so mutating one cannot reach another", () => {
    const a = routeLegV3(POOL);
    const b = routeLegV3(POOL);
    a.key.fee = 500;
    expect(b.key.fee).toBe(0);
  });
});

describe("routed trades", () => {
  const buy = {
    hop: routeLegV3(HOP_POOL),
    coin: routeLegV3(POOL),
    token: TOKEN,
    buy: true,
    amountIn: 1_000_000_000_000_000n,
    minOut: 42n,
    deadline: 1788598810n,
  };

  it("encodes a v3-hop / v3-coin buy as one RouteRequest struct", () => {
    const req = prepareVenueSwapRoute(ADDRESSES, buy);
    expect(req.to).toBe(ROUTER);
    expect(req.chainId).toBe(4663);
    // `cast sig` on the deployed signature, so a typo in the human-readable ABI string
    // is caught here rather than as an unexplained revert on chain.
    expect(req.data.slice(0, 10)).toBe("0x91a192c0");

    const { functionName, args } = decodeFunctionData({
      abi: rallyUniversalRouterAbi,
      data: req.data,
    });
    expect(functionName).toBe("swapRoute");
    expect(args).toEqual([
      {
        hop: {
          kind: 1,
          venue: HOP_POOL,
          manager: ZERO,
          key: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
        },
        coin: {
          kind: 1,
          venue: POOL,
          manager: ZERO,
          key: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
        },
        token: TOKEN,
        buy: true,
        amountIn: 1_000_000_000_000_000n,
        minOut: 42n,
        // Defaulted, like every other entrypoint here.
        unwrapOut: true,
        deadline: 1788598810n,
      },
    ]);
  });

  it("names neither the intermediate nor the trader's own asset", () => {
    // The whole route is hop + coin venue + token + direction. If either asset were a
    // parameter the caller could assert a conversion that never happened, so the fact
    // that there is nowhere to put one is the property worth pinning.
    const req = prepareVenueSwapRoute(ADDRESSES, buy);
    const { args } = decodeFunctionData({ abi: rallyUniversalRouterAbi, data: req.data });
    expect(Object.keys(args?.[0] as object)).toEqual([
      "hop",
      "coin",
      "token",
      "buy",
      "amountIn",
      "minOut",
      "unwrapOut",
      "deadline",
    ]);
  });

  it("carries a v4 hop and a v4 coin leg in the same tuple", () => {
    const hopKey = {
      currency0: ZERO,
      currency1: WETH,
      fee: 500,
      tickSpacing: 10,
      // A v4 HOP may be hookless. A v4 coin leg may not, which the router enforces.
      hooks: ZERO,
    };
    const coinKey = {
      currency0: WETH,
      currency1: TOKEN,
      fee: 3000,
      tickSpacing: 60,
      hooks: VENUE_HOOK,
    };
    const req = prepareVenueSwapRoute(ADDRESSES, {
      hop: routeLegV4(MANAGER, hopKey),
      coin: routeLegV4(MANAGER, coinKey),
      token: TOKEN,
      buy: false,
      amountIn: 10n ** 18n,
      minOut: 1n,
      deadline: 99n,
    });
    const { args } = decodeFunctionData({ abi: rallyUniversalRouterAbi, data: req.data });
    expect(args).toEqual([
      {
        hop: { kind: 2, venue: ZERO, manager: MANAGER, key: hopKey },
        coin: { kind: 2, venue: ZERO, manager: MANAGER, key: coinKey },
        token: TOKEN,
        buy: false,
        amountIn: 10n ** 18n,
        minOut: 1n,
        unwrapOut: true,
        deadline: 99n,
      },
    ]);
  });

  it("returns an unsigned request, with the native input attached and nothing else", () => {
    // Native or wETH in: `msg.value` must EQUAL `amountIn`, not merely cover it.
    const native = prepareVenueSwapRoute(ADDRESSES, { ...buy, value: buy.amountIn });
    expect(native).toEqual({
      to: ROUTER,
      data: native.data,
      value: 1_000_000_000_000_000n,
      chainId: 4663,
    });
    expect(native.data).toBe(prepareVenueSwapRoute(ADDRESSES, buy).data);

    // An ERC-20 input attaches nothing and is approved to the router instead. A sell's
    // input is the coin, so the same holds in the other direction.
    const sell = prepareVenueSwapRoute(ADDRESSES, { ...buy, buy: false });
    expect(sell.value).toBe(0n);
    expect(venueApprovalFor(ADDRESSES, TOKEN, buy.amountIn)?.to).toBe(TOKEN);
  });

  it("honours an explicit unwrapOut: false, for a trader who wants wETH back", () => {
    const req = prepareVenueSwapRoute(ADDRESSES, { ...buy, buy: false, unwrapOut: false });
    const { args } = decodeFunctionData({ abi: rallyUniversalRouterAbi, data: req.data });
    expect(args).toMatchObject([{ unwrapOut: false }]);
  });

  it("refuses a curve as the hop, which the router would revert as BadHopVenue", () => {
    // A curve prices one coin against one pair asset and has no second quote to convert
    // into. Legal as the coin leg, never as the hop.
    try {
      prepareVenueSwapRoute(ADDRESSES, { ...buy, hop: routeLegCurve(RESOLVER) });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as RallyError).code).toBe("VENUE_NOT_ROUTABLE");
    }
    // The same resolver on the coin leg is fine.
    expect(() =>
      prepareVenueSwapRoute(ADDRESSES, { ...buy, coin: routeLegCurve(RESOLVER) }),
    ).not.toThrow();
  });

  it("rejects a zero input, and a chain with no router at all", () => {
    expect(() => prepareVenueSwapRoute(ADDRESSES, { ...buy, amountIn: 0n })).toThrow(
      /greater than zero/,
    );
    try {
      prepareVenueSwapRoute(NO_ROUTER, buy);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as RallyError).code).toBe("MISSING_ADDRESS");
    }
  });
});

describe("chains without the router", () => {
  it("fails with MISSING_ADDRESS rather than building calldata to nowhere", () => {
    expect(() =>
      prepareVenueSwapV3(NO_ROUTER, POOL, {
        token: TOKEN,
        buy: true,
        exactIn: true,
        amount: 1n,
        amountLimit: 0n,
        deadline: 1n,
      }),
    ).toThrow(RallyError);
    try {
      venueApprovalFor(NO_ROUTER, TOKEN, 1n);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as RallyError).code).toBe("MISSING_ADDRESS");
    }
  });

  it("rejects a zero amount instead of sending a no-op", () => {
    expect(() =>
      prepareVenueSwapCurve(ADDRESSES, RESOLVER, {
        token: TOKEN,
        buy: true,
        amountIn: 0n,
        minOut: 0n,
        deadline: 1n,
      }),
    ).toThrow(/greater than zero/);
    expect(() =>
      prepareVenueSwapV4(ADDRESSES, {
        manager: MANAGER,
        key: {
          currency0: WETH,
          currency1: TOKEN,
          fee: 3000,
          tickSpacing: 60,
          hooks: VENUE_HOOK,
        },
        token: TOKEN,
        zeroForOne: true,
        amountSpecified: 0n,
        amountLimit: 1n,
        deadline: 1n,
      }),
    ).toThrow(/non-zero/);
  });
});
