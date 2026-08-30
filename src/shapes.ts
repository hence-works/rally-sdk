/**
 * PROTOCOL v2 curve shapes: the preset table, and validating a shape of your own.
 *
 * A v2 launch mints its whole curve as v4 liquidity, so a creator gets to decide how that
 * liquidity is DISTRIBUTED across the price range rather than only how much of it there
 * is. The shape is frozen at launch and cannot be changed afterwards, which is why this
 * exists as a read path a host can show someone before they commit.
 *
 * Everything here is read-only. The shape a launch actually gets is re-derived on chain
 * from the same inputs, and the hook re-checks the parts that decide whether a curve is
 * acceptable, so nothing below is trusted at launch time.
 */
import { readContract } from "viem/actions";
import type { Address } from "viem";
import { rallyCurveShapesAbi } from "./abis";
import { RallyError } from "./errors";
import { sqrtPriceAtTick, type LadderPosition } from "./clmm";
import type { CurveSegment, CurveShapes, PublicClientLike } from "./types";

/**
 * The shipped presets, by the ids `RallyCurveShapes` declares.
 *
 * FLAT is preset 0 and is the one governance cannot change: it is a single uniform range
 * over the whole curve, which reproduces v1's price schedule exactly. The other two are
 * governance-set and their segments are read from the chain, so the descriptions here say
 * what the shape is FOR, never what its numbers are.
 */
export const CURVE_PRESETS = [
  {
    id: 0,
    key: "FLAT" as const,
    name: "Flat",
    description:
      "One uniform range across the whole curve. The same price schedule as a v1 launch.",
  },
  {
    id: 1,
    key: "WALL" as const,
    name: "Wall",
    description:
      "Liquidity thickens toward the graduation price, so graduating costs real money and the handoff to the tail is smooth.",
  },
  {
    id: 2,
    key: "FLOOR" as const,
    name: "Floor",
    description:
      "Liquidity thickens toward the launch price, so the opening is deep and the first buyer cannot rip it away from the next hundred.",
  },
] as const;

export type CurvePresetKey = (typeof CURVE_PRESETS)[number]["key"];

/**
 * Read the whole shape surface for a v2 generation: every preset's segments, whether
 * bespoke shapes are open, and the bounds a bespoke one has to fit.
 *
 * A preset whose read reverts is reported as `segments: undefined` rather than dropped,
 * because governance can leave an id unset and "this preset is not configured" is a
 * different answer from "this chain has no preset table".
 */
export async function readCurveShapes(
  client: PublicClientLike,
  shapes: Address,
): Promise<CurveShapes> {
  const read = <T>(functionName: "customAllowed" | "MAX_SEGMENTS" | "MAX_POSITIONS_TOTAL") =>
    readContract(client, { address: shapes, abi: rallyCurveShapesAbi, functionName }) as Promise<T>;

  const [customAllowed, maxSegments, maxPositions, ...presets] = await Promise.all([
    read<boolean>("customAllowed"),
    read<bigint>("MAX_SEGMENTS"),
    read<bigint>("MAX_POSITIONS_TOTAL"),
    ...CURVE_PRESETS.map((p) =>
      readContract(client, {
        address: shapes,
        abi: rallyCurveShapesAbi,
        functionName: "presetOf",
        args: [p.id],
      })
        .then((s) => s as readonly CurveSegment[])
        .catch(() => undefined),
    ),
  ]);

  return {
    address: shapes,
    customAllowed,
    maxSegments: Number(maxSegments),
    maxPositionsTotal: Number(maxPositions),
    presets: CURVE_PRESETS.map((p, i) => ({
      ...p,
      segments: presets[i] as CurveSegment[] | undefined,
    })),
  };
}

/**
 * Check a bespoke shape against the on-chain rules, returning how many positions it would
 * mint.
 *
 * `validate` is `pure`, so this costs one `eth_call` and no state: run it while someone is
 * still editing, not at submit time. A shape that fails here fails the launch, and a
 * launch fails long after a salt has been mined and metadata pinned.
 *
 * Passing this is necessary but not sufficient. The hook independently re-checks the
 * allocation band and the opening-depth window against the curve the shape actually
 * produces for a given `B`, and those depend on the launch, not just on the shape.
 */
export async function validateCurveSegments(
  client: PublicClientLike,
  shapes: Address,
  segments: readonly CurveSegment[],
): Promise<{ ok: true; positions: number } | { ok: false; reason: string }> {
  if (segments.length === 0) return { ok: false, reason: "A shape needs at least one segment." };
  const total = segments.reduce((n, s) => n + s.sharesBps, 0);
  // Checked here as well as on chain because it is the one rule a person editing a shape
  // breaks constantly, and saying so without a round trip is the difference between a
  // form that guides and one that rejects.
  if (total !== 10_000) {
    return { ok: false, reason: `Segment shares must add up to 100%, not ${total / 100}%.` };
  }
  try {
    const positions = await readContract(client, {
      address: shapes,
      abi: rallyCurveShapesAbi,
      functionName: "validate",
      args: [segments as CurveSegment[]],
    });
    return { ok: true, positions: Number(positions) };
  } catch (e) {
    return { ok: false, reason: shapeRevertReason(e) };
  }
}

/** The shape table's rejections, in the terms a creator set them in. */
function shapeRevertReason(e: unknown): string {
  const data = revertSelector(e);
  switch (data) {
    case "0x2a1b2dd8": // BadShape()
      return "That shape breaks one of the curve rules: segments must run in order, cover the range without gaps or overlaps, and each needs at least one position.";
    case "0x0dd94b96": // TooManyPositions(uint256)
      return "That shape mints more positions than a curve is allowed to hold. Use fewer positions per segment.";
    default:
      return e instanceof Error && e.message ? e.message : "The shape table rejected that shape.";
  }
}

function revertSelector(e: unknown): string {
  for (let cur = e as { cause?: unknown; data?: unknown }, i = 0; cur && i < 12; i++) {
    if (typeof cur.data === "string" && cur.data.startsWith("0x")) return cur.data.slice(0, 10);
    cur = cur.cause as { cause?: unknown; data?: unknown };
  }
  return "";
}

/**
 * The ladder a launch WOULD get, before it exists.
 *
 * `buildCurve` is the same pure geometry the hook runs at `registerLaunch`, so this is the
 * real curve, not a model of it: feed the result to `simulateSwap` and a prospective first
 * buy prices exactly as it will fill.
 *
 * This is the only correct way to size a v2 first buy. The v1 arithmetic describes a
 * constant-product reserve, and a v2 curve is a shaped ladder, so the two disagree by
 * however far the shape departs from flat. They disagree most at the OPENING, which is
 * precisely where a first buy happens: on a small `B` a first buy that looks modest in
 * quote can take a large share of supply, which the factory then rejects.
 */
export async function previewLaunchCurve(
  client: PublicClientLike,
  shapes: Address,
  params: {
    /** Ignored when `segments` is given. */
    curvePreset?: number;
    segments?: readonly CurveSegment[];
    totalSupply: bigint;
    /** `S_c` as bps of `S`, which is how the factory passes it. */
    curveAllocBps: bigint;
    /** The launch's own `B`, in the quote's base units. */
    gradThreshold: bigint;
    /** Share of `S - S_c` placed in the tail. The factory passes all of it. */
    tailBps?: bigint;
    tickSpacing?: number;
  },
): Promise<{
  ladder: LadderPosition[];
  curveSupply: bigint;
  tickLower: number;
  tickUpper: number;
  /** `√P(0)`, the price the pool opens at, which is where a first buy starts from. */
  openSqrtPriceX96: bigint;
}> {
  const [positions, curveSupply, tickLower, tickUpper] = (await readContract(client, {
    address: shapes,
    abi: rallyCurveShapesAbi,
    functionName: "buildCurve",
    args: [
      {
        curvePreset: params.segments?.length ? 0 : (params.curvePreset ?? 0),
        segments: (params.segments ?? []) as CurveSegment[],
        totalSupply: params.totalSupply,
        curveAllocBps: params.curveAllocBps,
        B: params.gradThreshold,
        tailBps: params.tailBps ?? 10_000n,
        tickSpacing: params.tickSpacing ?? 60,
        // I-7 forces a launch token to sort below its quote, so a v2 launch token is
        // always currency0. Not a parameter a caller gets to be wrong about.
        tokenIsCurrency0: true,
      },
    ],
  })) as readonly [
    readonly { tickLower: number; tickUpper: number; liquidity: bigint }[],
    bigint,
    number,
    number,
  ];

  return {
    ladder: positions.map((p) => ({
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: p.liquidity,
    })),
    curveSupply,
    tickLower,
    tickUpper,
    openSqrtPriceX96: sqrtPriceAtTick(tickLower),
  };
}

/**
 * A shape as evenly-weighted segments across the range, which is the shape most people
 * mean when they draw one: `weights` is read left to right from the launch price to the
 * graduation price, and each entry is that band's share of the curve's tokens.
 *
 * Offered because `CurveSegment` is expressed in basis points of the tick span and is
 * easy to get subtly wrong by hand. The result still has to pass
 * {validateCurveSegments}.
 */
export function segmentsFromWeights(
  weights: readonly number[],
  positionsPerSegment = 2,
): CurveSegment[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0 || total <= 0) {
    throw new RallyError("INVALID_AMOUNT", "A shape needs at least one positive weight.");
  }
  const step = Math.floor(10_000 / weights.length);
  let sharesLeft = 10_000;
  return weights.map((w, i) => {
    const last = i === weights.length - 1;
    // The last band absorbs the rounding on both axes, so the spans tile the whole range
    // and the shares sum to exactly 100%.
    const shares = last ? sharesLeft : Math.round((w / total) * 10_000);
    sharesLeft -= shares;
    return {
      startBps: i * step,
      endBps: last ? 10_000 : (i + 1) * step,
      numPositions: positionsPerSegment,
      sharesBps: shares,
      // Anchor each band at its far edge, which is what makes a heavier band read as
      // depth at that end of the range rather than as a step in the middle.
      anchorAtFar: false,
    };
  });
}
