/**
 * Guards on the two things a caller can get wrong in a way the chain only catches
 * after they have already paid for a grind and a metadata pin.
 */
import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Address } from "viem";
import {
  parseLaunchReceipt,
  validateFeeSplit,
  validateLaunchMetadataDocument,
  validateMetadataURI,
} from "../src/launch";
import { applySlippage, toleranceFor, EXACT_SLIPPAGE_BPS, APPROX_SLIPPAGE_BPS } from "../src/trade";
import { RallyError } from "../src/errors";
import type { FeePolicy } from "../src/types";

const OPEN: FeePolicy = {
  platformBps: 2_500,
  creatorCapBps: 10_000,
  mechanismMask: 7,
  dividendEnabled: true,
  buybackEnabled: true,
  lpSupportEnabled: true,
};

/** A complete document, the shape Rally pins and every venue reads. */
const DOC = {
  name: "Good Dog",
  symbol: "WOOF",
  imageUrl: "https://cdn.example.com/woof.png",
  description: "he is a good dog",
  website: "https://gooddog.example",
  twitter: "@gooddog",
  telegram: "gooddog",
};

/** The two encodings a `data:` URI can carry, so both paths are exercised. */
function inlineURI(doc: unknown, encoding: "percent" | "base64" = "percent"): string {
  const json = JSON.stringify(doc);
  return encoding === "base64"
    ? `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`
    : `data:application/json,${encodeURIComponent(json)}`;
}

describe("validateLaunchMetadataDocument", () => {
  it("returns the document normalized, with blank optionals dropped", () => {
    expect(
      validateLaunchMetadataDocument({ ...DOC, website: "  ", telegram: "" }),
    ).toEqual({
      name: "Good Dog",
      symbol: "WOOF",
      imageUrl: "https://cdn.example.com/woof.png",
      description: "he is a good dog",
      twitter: "@gooddog",
    });
  });

  it("accepts `image` as an alias and an ipfs logo", () => {
    const { imageUrl: _drop, ...rest } = DOC;
    expect(
      validateLaunchMetadataDocument({ ...rest, image: "ipfs://bafyfoo/logo.png" }).imageUrl,
    ).toBe("ipfs://bafyfoo/logo.png");
  });

  it("leaves unknown keys alone", () => {
    expect(() =>
      validateLaunchMetadataDocument({ ...DOC, fee_recipient: "0xabc", decimals: 18 }),
    ).not.toThrow();
  });

  it.each(["name", "symbol", "imageUrl"])("requires %s", (field) => {
    const doc: Record<string, unknown> = { ...DOC };
    delete doc[field];
    expect(() => validateLaunchMetadataDocument(doc)).toThrow(RallyError);
  });

  it("rejects a blank required field", () => {
    expect(() => validateLaunchMetadataDocument({ ...DOC, name: "   " })).toThrow(/required/);
  });

  it("rejects a non-string field", () => {
    expect(() => validateLaunchMetadataDocument({ ...DOC, description: 42 })).toThrow(
      /must be a string/,
    );
  });

  it("rejects a document that isn't an object", () => {
    expect(() => validateLaunchMetadataDocument([DOC])).toThrow(RallyError);
    expect(() => validateLaunchMetadataDocument("nope")).toThrow(RallyError);
  });

  // Each of these renders as nothing downstream, so it fails here instead.
  it.each([
    ["a data: logo", { imageUrl: "data:image/png;base64,iVBOR" }],
    ["an http logo", { imageUrl: "http://cdn.example.com/woof.png" }],
    ["a scheme-less website", { website: "gooddog.example" }],
    ["a website that isn't a link", { website: "javascript:alert(1)" }],
    ["a handle carrying a scheme", { twitter: "javascript:alert(1)" }],
    ["a handle carrying a path", { telegram: "t.me/gooddog" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => validateLaunchMetadataDocument({ ...DOC, ...patch })).toThrow(RallyError);
  });

  it("accepts a social given as a full URL", () => {
    expect(
      validateLaunchMetadataDocument({ ...DOC, twitter: "https://x.com/gooddog" }).twitter,
    ).toBe("https://x.com/gooddog");
  });

  it("rejects a field past the length the read models store", () => {
    expect(() => validateLaunchMetadataDocument({ ...DOC, name: "a".repeat(129) })).toThrow(
      /limit is 128/,
    );
  });
});

describe("validateMetadataURI", () => {
  // The three forms a consumer can still dereference years after the launch.
  it.each([
    "https://assets.rallypad.fun/4663/0xabc.json",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/metadata.json",
    inlineURI(DOC),
    inlineURI(DOC, "base64"),
  ])("accepts %s", (uri) => {
    expect(validateMetadataURI(uri)).toBe(uri);
  });

  it("trims", () => {
    const uri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    expect(validateMetadataURI(`  ${uri}  `)).toBe(uri);
  });

  // `ipfs://rallypad` and `ipfs://noodle` are both frozen onto real tokens on 4663.
  it.each([
    "ipfs://",
    "https://",
    "  ",
    "ipfs://rallypad",
    "ipfs://noodle",
  ])("rejects the placeholder %s", (uri) => {
    expect(() => validateMetadataURI(uri)).toThrow(RallyError);
  });

  it("rejects http://, since mixed content is a dead logo", () => {
    expect(() => validateMetadataURI("http://example.com/meta.json")).toThrow(/https:/);
  });

  it("checks the document an inline URI carries", () => {
    const { symbol: _drop, ...noSymbol } = DOC;
    expect(() => validateMetadataURI(inlineURI(noSymbol))).toThrow(/symbol/);
    expect(() => validateMetadataURI(inlineURI({ ...DOC, website: "gooddog.example" }))).toThrow(
      /website/,
    );
    // The document that shipped on 0x1f607ea2: socials and a description, no identity.
    expect(() =>
      validateMetadataURI(
        "data:application/json,%7B%22website%22%3A%22%22%2C%22description%22%3A%22Rally%22%2C%22twitter%22%3A%22%22%7D",
      ),
    ).toThrow(/name/);
  });

  it("decodes multibyte characters out of a base64 document", () => {
    const doc = { ...DOC, description: "he is a good dog — really" };
    expect(validateMetadataURI(inlineURI(doc, "base64"))).toContain("data:application/json;base64,");
  });

  it("rejects an inline URI with no document", () => {
    expect(() => validateMetadataURI("data:application/json,")).toThrow(/JSON document/);
  });

  it("rejects a non-JSON data URI", () => {
    expect(() => validateMetadataURI("data:text/plain,hello")).toThrow(RallyError);
  });

  it("rejects a bare name", () => {
    expect(() => validateMetadataURI("noodle")).toThrow(RallyError);
  });
});

describe("validateFeeSplit", () => {
  it("accepts a split that sums to 10000", () => {
    expect(() =>
      validateFeeSplit(
        { creatorBps: 5_000, dividendBps: 5_000, buybackBps: 0, lpSupportBps: 0 },
        OPEN,
      ),
    ).not.toThrow();
  });

  it("rejects a split that doesn't sum to 10000", () => {
    expect(() =>
      validateFeeSplit({ creatorBps: 100, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 }, OPEN),
    ).toThrow(RallyError);
  });

  it("rejects a creator share over the governance cap", () => {
    const capped: FeePolicy = { ...OPEN, creatorCapBps: 8_000 };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 10_000, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
        capped,
      ),
    ).toThrow(/exceeds the governance cap/);
  });

  it("rejects a mechanism governance has switched off", () => {
    const noBuyback: FeePolicy = { ...OPEN, mechanismMask: 5, buybackEnabled: false };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 5_000, dividendBps: 0, buybackBps: 5_000, lpSupportBps: 0 },
        noBuyback,
      ),
    ).toThrow(/buyback/);
  });

  it("allows a zero share in a disabled mechanism", () => {
    const noBuyback: FeePolicy = { ...OPEN, mechanismMask: 5, buybackEnabled: false };
    expect(() =>
      validateFeeSplit(
        { creatorBps: 10_000, dividendBps: 0, buybackBps: 0, lpSupportBps: 0 },
        noBuyback,
      ),
    ).not.toThrow();
  });
});

describe("parseLaunchReceipt", () => {
  const HOOK: Address = "0x1B8e0c4163E4Db303Fc78E9b35801E8B87e8a888";

  it("treats a mined-but-reverted transaction as a failure", () => {
    // waitForTransactionReceipt resolves for a reverted tx too — inclusion is not success.
    const receipt = { status: "reverted", logs: [], transactionHash: keccak256(toHex("x")) };
    expect(() => parseLaunchReceipt(receipt as never, HOOK)).toThrow(/reverted on-chain/);
  });

  it("errors clearly when no Launched event came from the expected hook", () => {
    const receipt = { status: "success", logs: [], transactionHash: keccak256(toHex("x")) };
    expect(() => parseLaunchReceipt(receipt as never, HOOK)).toThrow(/No Launched event/);
  });

  // The first buy's amounts come from `RallyFactory.FirstBuy` and from nowhere else. The
  // v4 `Swap` the same buy triggers has BOTH legs zero — a curve fill is answered entirely
  // by the hook's `BeforeSwapDelta`, so v4 moves no liquidity — which is why reading the
  // `Swap` left `firstBuyTokens` permanently undefined.
  const FACTORY: Address = "0xB237b78903C12B34F6cf099cf5ef701EF158BFE5";
  const POOL_MANAGER: Address = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";
  const PID = keccak256(toHex("pid"));
  const TOKEN: Address = "0x1f60EBa664cb43348a91a50dbcACAE0aDD7a595f";
  const CREATOR: Address = "0xAebC4577f2DB3A819448d8e1779cfA851B5dbac0";
  const WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

  /** wETH < token here, so currency0 is the quote: creator pays leg0, receives leg1. */
  const SPENT = 1_000_000_000_000_000_000n;
  const RECEIVED = 4_200_000_000_000_000_000_000n;

  function receiptWith(logs: unknown[]) {
    return { status: "success", logs, transactionHash: keccak256(toHex("x")) } as never;
  }

  it("reads the first buy from FirstBuy, not from the zero-legged v4 Swap", async () => {
    const { encodeAbiParameters, encodeEventTopics, parseAbiParameters } = await import("viem");
    const { rallyFactoryAbi, rallyHookAbi, poolManagerAbi } = await import("../src/abis");

    const logs = [
      {
        address: HOOK,
        topics: encodeEventTopics({
          abi: rallyHookAbi,
          eventName: "Launched",
          args: { pid: PID, token: TOKEN, creator: CREATOR },
        }),
        data: encodeAbiParameters(parseAbiParameters("address, uint256, string"), [
          WETH,
          5_000_000_000_000_000_000n,
          "ipfs://meta",
        ]),
      },
      // The v4 Swap the first buy triggers: real, and structurally empty.
      {
        address: POOL_MANAGER,
        topics: encodeEventTopics({
          abi: poolManagerAbi,
          eventName: "Swap",
          args: { id: PID, sender: FACTORY },
        }),
        data: encodeAbiParameters(
          parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"),
          [0n, 0n, 79228162514264337593543950336n, 0n, 0, 0],
        ),
      },
      {
        address: FACTORY,
        topics: encodeEventTopics({
          abi: rallyFactoryAbi,
          eventName: "FirstBuy",
          args: { pid: PID, buyer: CREATOR },
        }),
        data: encodeAbiParameters(parseAbiParameters("int128, int128, uint160, int24"), [
          -SPENT,
          RECEIVED,
          79228162514264337593543950336n,
          0,
        ]),
      },
    ];

    const parsed = parseLaunchReceipt(receiptWith(logs), HOOK, FACTORY);
    expect(parsed.token).toBe(TOKEN);
    expect(parsed.firstBuyTokens).toBe(RECEIVED);

    // Without the factory there is nothing to read it from — the Swap cannot supply it.
    expect(parseLaunchReceipt(receiptWith(logs), HOOK).firstBuyTokens).toBeUndefined();
  });
});

describe("slippage bounds", () => {
  it("bounds an exact curve estimate tightly and an approximate one loosely", () => {
    expect(toleranceFor(true)).toBe(EXACT_SLIPPAGE_BPS);
    expect(toleranceFor(false)).toBe(APPROX_SLIPPAGE_BPS);
    expect(applySlippage(1_000n, 100n)).toBe(990n);
    expect(applySlippage(1_000n, 500n)).toBe(950n);
  });

  it("returns 0 when there is nothing to bound rather than inventing a floor", () => {
    expect(applySlippage(0n, 100n)).toBe(0n);
    expect(applySlippage(1_000n, 10_000n)).toBe(0n);
  });
});
