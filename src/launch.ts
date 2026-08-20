/**
 * The launch path: everything between "a user typed a name and ticker" and a coin
 * trading on the curve.
 *
 * The order is forced by the protocol and cannot be rearranged:
 *
 *   read the quote's fee + B  →  mine a creator-bound vanity salt  →  the token
 *   address is now known  →  pin metadata at that address  →  launch(…)
 *
 * The address has to exist before the metadata, because the pin path embeds it; the
 * salt has to be creator-bound, because `launch` rejects any other; and the fee has to
 * be read, because it is per-quote and governance-tunable.
 */
import {
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { readContract } from "viem/actions";
import { erc20Abi, rallyFactoryAbi, rallyHookAbi } from "./abis";
import { RallyError } from "./errors";
import { mineVanitySalt } from "./mine";
import { poolIdOf } from "./pool";
import { packSalt, saltCreator, type Vanity } from "./salt";
import type {
  FeePolicy,
  FeeSplit,
  LaunchMetadata,
  LaunchMetadataParams,
  LaunchStep,
  PublicClientLike,
  QuoteConfig,
  RallyAddresses,
  TxRequest,
} from "./types";

export interface LaunchParams {
  name: string;
  symbol: string;
  /**
   * Quote asset: an allowlisted address, or `"WETH"` / `"USDC"` for the chain's
   * canonical ones. Each quote carries its own launch fee and graduation threshold.
   */
  quote?: Address | "WETH" | "USDC";
  /** The launching wallet. Defaults to the client's account. */
  creator?: Address;
  /** Optional fee-exempt creator first buy, in the quote's base units. */
  initialBuy?: bigint;
  /**
   * The §6.1 split of the post-platform fee remainder. Omit to use the governance
   * defaults — which the SDK does by calling the 6-arg `launch` overload, so the
   * default is resolved on-chain rather than guessed here.
   */
  fees?: FeeSplit;
  /**
   * An already-hosted metadata JSON. Mutually exclusive with `metadata`. Must be
   * `https://`, `ipfs://`, or an inline `data:application/json` URI. See
   * {@link validateMetadataURI}, which also explains what renders on Rally's own
   * surfaces and what does not.
   */
  metadataURI?: string;
  /**
   * Metadata to pin through the configured service. Mutually exclusive with
   * `metadataURI`. `imageUrl` is required (upload one with `uploadImage`); `name`
   * and `symbol` default to this launch's own.
   */
  metadata?: LaunchMetadataParams;
  /**
   * Pin `metadata` with this instead of the client's configured pinner, for this launch
   * only. The token address is mined before it is called, which is the whole reason a
   * pin cannot simply happen first: Rally's pin path is keyed by the address.
   *
   * A host that already holds a session (its own SIWE JWT, its own storage) passes one
   * here rather than making a throwaway `prepareLaunch` call to learn the address and a
   * second to build the calldata. It also has nowhere else to put a "pinning now" tick,
   * so `onStep` fires around it.
   */
  pin?: PinLaunchMetadata;
  /** A pre-mined salt. Must be creator-bound and hit the vanity pattern. */
  salt?: Hex;
  /**
   * How to fund `launchFee + initialBuy`. `"native"` attaches ETH as `msg.value` and
   * needs no approval — only valid when the quote is the chain's wETH. `"erc20"`
   * transfers from the creator and needs an allowance to the factory.
   * Defaults to `"native"` for a wETH-quoted launch, `"erc20"` otherwise.
   */
  fundWith?: "native" | "erc20";
  /** Approve `type(uint256).max` instead of the exact amount owed. Default false. */
  approveMax?: boolean;
  mining?: {
    onProgress?: (attempts: number) => void;
    signal?: AbortSignal;
    maxAttempts?: number;
    startNonce?: bigint;
    stride?: bigint;
    batchSize?: number;
    yieldBetweenBatches?: boolean;
  };
  onStep?: (step: LaunchStep) => void;
}

/** A fully-resolved launch, ready to sign. Nothing here has touched the chain yet. */
export interface PreparedLaunch {
  /** The CREATE2 address the token will land at — already committed to by the salt. */
  token: Address;
  /** The v4 PoolId the launch will be keyed by, derived locally. */
  pid: Hex;
  salt: Hex;
  creator: Address;
  metadataURI: string;
  quote: QuoteConfig;
  /** The launch fee, in the quote's base units. */
  launchFee: bigint;
  initialBuy: bigint;
  /** `launchFee + initialBuy` — what the creator pays in total, excluding gas. */
  totalCost: bigint;
  fees?: FeeSplit;
  /** How the cost is funded — `"native"` sets `request.value`. */
  fundWith: "native" | "erc20";
  /** Present only when an ERC-20 allowance short of `totalCost` was found. */
  approval?: TxRequest;
  /** The `launch(...)` transaction. */
  request: TxRequest;
}

/** What a confirmed launch produced, parsed from its receipt. */
export interface LaunchResult {
  token: Address;
  pid: Hex;
  creator: Address;
  quote: Address;
  gradThreshold: bigint;
  metadataURI: string;
  transactionHash: Hex;
  receipt: TransactionReceipt;
  /** Tokens the creator received from `initialBuy`, if any. */
  firstBuyTokens?: bigint;
}

/** Read a quote's allowlist entry and per-quote economics. */
export async function readQuoteConfig(
  client: PublicClientLike,
  factory: Address,
  quote: Address,
  weth: Address,
): Promise<QuoteConfig> {
  const [allowed, decimals, gradThreshold, launchFee, scale] = await readContract(client, {
    address: factory,
    abi: rallyFactoryAbi,
    functionName: "quotes",
    args: [quote],
  });
  return {
    address: quote,
    allowed,
    decimals,
    gradThreshold,
    launchFee,
    scale,
    isNative: quote.toLowerCase() === weth.toLowerCase(),
  };
}

/** Read the factory's current vanity pattern. */
export async function readTokenVanity(
  client: PublicClientLike,
  factory: Address,
): Promise<Vanity> {
  const [prefixLen, suffixLen, prefixBits, suffixBits] = await readContract(client, {
    address: factory,
    abi: rallyFactoryAbi,
    functionName: "tokenVanity",
  });
  return { prefixLen, suffixLen, prefixBits, suffixBits };
}

/**
 * Validate a split against on-chain policy before anything is mined or pinned.
 *
 * The chain enforces all of this anyway — but it does so in `launch`, i.e. after the
 * user has already waited on a grind and burned a metadata pin. Failing here costs
 * three cached registry reads.
 */
export function validateFeeSplit(fees: FeeSplit, policy: FeePolicy): void {
  const sum = fees.creatorBps + fees.dividendBps + fees.buybackBps + fees.lpSupportBps;
  if (sum !== 10_000) {
    throw new RallyError(
      "INVALID_FEE_SPLIT",
      `Fee split must sum to 10000 bps (got ${sum}). It partitions the post-platform ` +
        `remainder — the platform's ${policy.platformBps} bps cut is taken off the top.`,
      { details: { fees, sum } },
    );
  }
  if (fees.creatorBps > policy.creatorCapBps) {
    throw new RallyError(
      "INVALID_FEE_SPLIT",
      `creatorBps ${fees.creatorBps} exceeds the governance cap of ${policy.creatorCapBps}.`,
      { details: { fees, cap: policy.creatorCapBps } },
    );
  }
  const disabled: string[] = [];
  if (fees.dividendBps > 0 && !policy.dividendEnabled) disabled.push("dividend");
  if (fees.buybackBps > 0 && !policy.buybackEnabled) disabled.push("buyback");
  if (fees.lpSupportBps > 0 && !policy.lpSupportEnabled) disabled.push("lpSupport");
  if (disabled.length) {
    throw new RallyError(
      "INVALID_FEE_SPLIT",
      `Governance has these fee mechanisms disabled: ${disabled.join(", ")}.`,
      { details: { fees, mechanismMask: policy.mechanismMask } },
    );
  }
}

/**
 * Caps on every field of a metadata document.
 *
 * These are the indexer's, not this package's: a longer value is stored truncated on
 * the read models every venue (Rally's included) lists coins from, so a document that
 * exceeds one renders differently from the document you wrote. Rejecting is the honest
 * outcome, since the URI cannot be edited afterwards.
 */
const METADATA_LIMITS = {
  name: 128,
  symbol: 32,
  description: 2_000,
  url: 512,
  handle: 256,
} as const;

/**
 * The whole inline document, capped the way an on-chain string should be. Matches the
 * indexer's ceiling: past it a coin resolves to nothing at all, which is worse than a
 * launch that fails here.
 */
const INLINE_MAX_BYTES = 256 * 1024;

/** `data:` payload to text, in a browser or in Node. */
function decodeInlinePayload(payload: string, base64: boolean): string {
  if (!base64) return decodeURIComponent(payload);
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(payload);
    // atob yields one char per BYTE, so a multibyte character (an em dash in a
    // description, an emoji in a name) has to be decoded as UTF-8, not read off as
    // code units.
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }
  return Buffer.from(payload, "base64").toString("utf8");
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new RallyError("METADATA_REQUIRED", message, details ? { details } : undefined);
}

/** A present-and-non-blank string field, or undefined. Anything non-string is an error. */
function optionalField(doc: Record<string, unknown>, keys: string[], limit: number): string | undefined {
  for (const key of keys) {
    const value = doc[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      fail(`metadata \`${key}\` must be a string, got ${typeof value}.`);
    }
    // Blank is how "no website" is spelled by most launch UIs, so it means absent
    // rather than invalid. The alias keys are only consulted while nothing has hit.
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.length > limit) {
      fail(
        `metadata \`${key}\` is ${trimmed.length} characters; the limit is ${limit}. ` +
          `Longer values are stored truncated, and the URI cannot be edited later.`,
      );
    }
    return trimmed;
  }
  return undefined;
}

function requiredField(doc: Record<string, unknown>, keys: string[], limit: number): string {
  const value = optionalField(doc, keys, limit);
  if (!value) {
    fail(
      `metadata \`${keys[0]}\` is required and must be a non-empty string. A document ` +
        `without it leaves the coin rendering as a bare address on every venue that ` +
        `lists it, permanently.`,
      { missing: keys[0] },
    );
  }
  return value;
}

/**
 * Validate a launch metadata document and return it normalized.
 *
 * This is the shape Rally pins and every venue reads: `name`, `symbol` and `imageUrl`
 * required, `description`, `bannerUrl` and the socials optional. Extra keys are left
 * alone (self-hosted documents carry their own venue's fields, and dropping them is
 * not this function's business), blank optionals count as absent, and `image` /
 * `banner` are accepted as aliases because that is the ERC-721 spelling most tooling
 * writes.
 *
 * Every rule here is about what actually renders downstream, not taste:
 *
 *   - images accept `https://` and `ipfs://`, the two schemes a venue will hand to an
 *     `<img>`. A `data:` image inside the document is dropped by the read models, so
 *     it is refused rather than silently blanked.
 *   - `website` must be absolute http(s). A bare `rallypad.fun` is not a link a venue can
 *     render without guessing a scheme, so it is not stored as one.
 *   - `twitter` / `telegram` take a bare handle (`gooddog`, `@gooddog`) or a full
 *     http(s) URL, because creators enter both. Anything else carrying a `:` or `/` is
 *     refused: venues normalize a handle by pasting it after `https://x.com/`, which
 *     turns a stray scheme into a broken-but-clickable link.
 */
export function validateLaunchMetadataDocument(doc: unknown): LaunchMetadata {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    fail("Launch metadata must be a JSON object.");
  }
  const m = doc as Record<string, unknown>;

  const media = (keys: [string, ...string[]], required: boolean): string | undefined => {
    const value = required
      ? requiredField(m, keys, METADATA_LIMITS.url)
      : optionalField(m, keys, METADATA_LIMITS.url);
    if (value && !/^(https:\/\/|ipfs:\/\/)/i.test(value)) {
      fail(
        `metadata \`${keys[0]}\` must be an https:// or ipfs:// URL, got "${value.slice(0, 60)}". ` +
          `Upload the file first and reference it by URL.`,
        { field: keys[0], value: value.slice(0, 200) },
      );
    }
    return value;
  };

  const website = optionalField(m, ["website"], METADATA_LIMITS.url);
  if (website && !/^https?:\/\//i.test(website)) {
    fail(
      `metadata \`website\` must be an absolute http(s) URL, got "${website.slice(0, 60)}".`,
      { website: website.slice(0, 200) },
    );
  }

  const social = (key: "twitter" | "telegram"): string | undefined => {
    const value = optionalField(m, [key], METADATA_LIMITS.handle);
    if (value && !/^https?:\/\//i.test(value) && /[:/]/.test(value)) {
      fail(
        `metadata \`${key}\` must be a bare handle or a full http(s) URL, got ` +
          `"${value.slice(0, 60)}".`,
        { [key]: value.slice(0, 200) },
      );
    }
    return value;
  };

  const out: LaunchMetadata = {
    name: requiredField(m, ["name"], METADATA_LIMITS.name),
    symbol: requiredField(m, ["symbol"], METADATA_LIMITS.symbol),
    imageUrl: media(["imageUrl", "image"], true)!,
  };
  const description = optionalField(m, ["description"], METADATA_LIMITS.description);
  const bannerUrl = media(["bannerUrl", "banner"], false);
  const twitter = social("twitter");
  const telegram = social("telegram");
  if (description) out.description = description;
  if (bannerUrl) out.bannerUrl = bannerUrl;
  if (website) out.website = website;
  if (twitter) out.twitter = twitter;
  if (telegram) out.telegram = telegram;
  return out;
}

/**
 * Check a self-hosted `metadataURI` before it is frozen onto the token forever.
 *
 * `launch()` takes an arbitrary string and the token stores it write-once, so a typo
 * here is permanent: coins have shipped carrying `ipfs://rallypad`, which resolves to
 * nothing and never will. Only three forms can actually be dereferenced by a consumer
 * years from now, so only these three are accepted:
 *
 *   - `https://...`, a URL you keep alive. `http://` is refused, because every venue
 *     rendering this coin is served over https and a mixed content logo is a dead logo.
 *   - `ipfs://...`, content addressed, and the one form that outlives its host.
 *   - `data:application/json,...`, the document inline, which cannot rot at all. It
 *     costs calldata for the length of the JSON, so keep it to the display fields.
 *
 * The inline form is also the only one whose document is readable from here, so it is
 * additionally checked against the metadata schema
 * ({@link validateLaunchMetadataDocument}: `name`, `symbol` and `imageUrl` required,
 * `description`, `bannerUrl` and the socials optional). An https or ipfs URI is checked
 * for shape only, since nothing may be fetched during a launch.
 *
 * Note for hosts rendering Rally's own surfaces: those resolve a coin's display fields
 * from Rally's pinning bucket or from an inline `data:` URI, and never dereference an
 * arbitrary URL, since an indexer fetching creator supplied hosts is an SSRF rail. A
 * launch self hosted on https is valid and renders in *your* venue from your own
 * document; it just shows as a bare address on Rally's. Pass `metadata` instead to be
 * listed there, or inline the JSON.
 */
export function validateMetadataURI(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) {
    throw new RallyError(
      "METADATA_REQUIRED",
      "`metadataURI` is empty. Pass the URI of JSON you host, or `metadata` to pin it.",
    );
  }
  const inline = /^data:application\/json([^,]*),([\s\S]*)$/i.exec(trimmed);
  const inlineJson = inline !== null;
  if (!/^(https:\/\/|ipfs:\/\/)/i.test(trimmed) && !inlineJson) {
    throw new RallyError(
      "METADATA_REQUIRED",
      `\`metadataURI\` must be https://, ipfs://, or an inline data:application/json ` +
        `URI. Got "${trimmed.slice(0, 60)}". It is frozen onto the token at launch, so ` +
        `anything else is permanently unresolvable.`,
      { details: { metadataURI: trimmed.slice(0, 200) } },
    );
  }
  if (inline) {
    // The one form whose document is readable from here, so it is the one form checked
    // against the schema rather than taken on faith. A pinned blob gets the same
    // treatment from the pinning service; an https or ipfs URI is somebody else's host
    // and is only ever checked by whoever fetches it.
    if (trimmed.length > INLINE_MAX_BYTES) {
      fail(
        `An inline \`metadataURI\` is ${trimmed.length} bytes; the limit is ` +
          `${INLINE_MAX_BYTES}. Past it the document is not read at all.`,
      );
    }
    const [, params, payload] = inline;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeInlinePayload(payload ?? "", /;base64$/i.test(params ?? "")));
    } catch (cause) {
      throw new RallyError(
        "METADATA_REQUIRED",
        "An inline `metadataURI` must carry a JSON document: " +
          `\`data:application/json,\` + encodeURIComponent(JSON.stringify(metadata)), or ` +
          "the same base64 encoded with a `;base64` parameter.",
        { cause },
      );
    }
    validateLaunchMetadataDocument(parsed);
  } else {
    // `ipfs://` or `https://` with nothing after it is a hand typed placeholder rather
    // than a location: the exact mistake this function exists for.
    const rest = trimmed.replace(/^[a-z]+:\/\//i, "").trim();
    if (!rest) {
      throw new RallyError(
        "METADATA_REQUIRED",
        `\`metadataURI\` is just a scheme ("${trimmed}"): it points at nothing.`,
      );
    }
    // An ipfs path starts with a CID, and every CID encoding is long: 46 chars for a
    // base58 v0 (`Qm...`), 59 for a base32 v1 (`bafy...`). This is a shape check, not a
    // CID parse, and it exists because `ipfs://rallypad` and `ipfs://noodle` are both
    // frozen onto real tokens today. Coins whose name happens to be their whole URI is
    // not a case worth being lenient for.
    const cid = rest.split(/[/?#]/, 1)[0] ?? "";
    if (/^ipfs:\/\//i.test(trimmed) && !/^[A-Za-z0-9]{32,}$/.test(cid)) {
      throw new RallyError(
        "METADATA_REQUIRED",
        `\`metadataURI\` "${trimmed}" is not an ipfs CID. Expected ipfs://<cid>[/path], ` +
          `e.g. ipfs://bafy.../metadata.json.`,
        { details: { metadataURI: trimmed.slice(0, 200) } },
      );
    }
  }
  return trimmed;
}

/**
 * The complete blob to pin, from what the caller supplied plus the launch's own
 * name and symbol.
 *
 * An explicit override wins, but only when it carries something: a blank `name` or
 * `symbol` would otherwise shadow the launch's own and pin a coin with no identity
 * on it. `imageUrl` is typed as required, but a JS caller can still omit it, so it
 * is checked rather than assumed, and the result goes through
 * {@link validateLaunchMetadataDocument} like any other document.
 */
function resolvePinMetadata(
  metadata: LaunchMetadataParams,
  name: string,
  symbol: string,
): LaunchMetadata {
  if (!metadata.imageUrl?.trim()) {
    throw new RallyError(
      "METADATA_REQUIRED",
      "`metadata.imageUrl` is required — upload a logo first (`uploadImage`) and pass " +
        "its public URL, or self-host the JSON and pass `metadataURI` instead.",
    );
  }
  // Through the same schema check as an inline document, so a launch fails the same way
  // whoever is holding the JSON. Without it a `website: "gooddog.example"` pins fine and
  // then renders as nothing, which is only discoverable after the coin exists.
  return validateLaunchMetadataDocument({
    ...metadata,
    imageUrl: metadata.imageUrl.trim(),
    name: metadata.name?.trim() || name,
    symbol: metadata.symbol?.trim() || symbol,
  });
}

/**
 * Pins a launch's metadata and returns the URI to freeze onto the token. `metadata`
 * arrives fully resolved and validated, so an implementation only has to store it.
 */
export type PinLaunchMetadata = (input: {
  chainId: number;
  tokenAddress: Address;
  metadata: LaunchMetadata;
}) => Promise<string>;

/** Everything `prepareLaunch` needs that the client already knows. */
export interface PrepareLaunchContext {
  client: PublicClientLike;
  addresses: RallyAddresses;
  factory: Address;
  account?: Address;
  feePolicy: () => Promise<FeePolicy>;
  /**
   * Pins metadata and returns the URI; absent when no pinner is configured.
   * `metadata` arrives fully resolved — `name`/`symbol` already defaulted from the
   * launch — so a pinner never has to re-derive them. `LaunchParams.pin` overrides
   * this per launch.
   */
  pin?: PinLaunchMetadata;
  resolveQuote: (quote: LaunchParams["quote"]) => Address;
}

export async function prepareLaunch(
  ctx: PrepareLaunchContext,
  params: LaunchParams,
): Promise<PreparedLaunch> {
  const { client, addresses, factory } = ctx;
  const step = params.onStep ?? (() => {});

  const name = params.name.trim();
  const symbol = params.symbol.trim().toUpperCase();
  if (!name || !symbol) {
    throw new RallyError("INVALID_AMOUNT", "A launch needs both a name and a symbol.");
  }

  const creator = params.creator ?? ctx.account;
  if (!creator) {
    throw new RallyError(
      "NO_ACCOUNT",
      "No creator address. Pass `creator`, or give the client a walletClient with an account.",
    );
  }

  if (params.metadataURI && params.metadata) {
    throw new RallyError(
      "METADATA_REQUIRED",
      "Pass either `metadataURI` (self-hosted) or `metadata` (pinned by Rally), not both.",
    );
  }
  if (!params.metadataURI && !params.metadata) {
    throw new RallyError(
      "METADATA_REQUIRED",
      "A launch needs metadata: pass `metadataURI` for JSON you host, or `metadata` to " +
        "pin it through the configured service.",
    );
  }
  // Resolved (and validated) before the salt grind: a missing logo, or a URI that can
  // never resolve, should cost nothing, not surface as an opaque 400 from the pinning
  // service (or as a permanently nameless coin) after minutes of mining.
  const pinMetadata = params.metadata
    ? resolvePinMetadata(params.metadata, name, symbol)
    : undefined;
  const selfHostedURI = params.metadataURI
    ? validateMetadataURI(params.metadataURI)
    : undefined;

  step("resolving");
  const quoteAddress = ctx.resolveQuote(params.quote);
  const quote = await readQuoteConfig(client, factory, quoteAddress, addresses.weth);
  if (!quote.allowed) {
    throw new RallyError(
      "QUOTE_NOT_ALLOWED",
      `${quoteAddress} is not an allowlisted quote on chain ${addresses.chainId}.`,
      { details: { quote: quoteAddress } },
    );
  }

  if (params.fees) validateFeeSplit(params.fees, await ctx.feePolicy());

  const initialBuy = params.initialBuy ?? 0n;
  if (initialBuy < 0n) {
    throw new RallyError("INVALID_AMOUNT", "initialBuy cannot be negative.");
  }
  const totalCost = quote.launchFee + initialBuy;
  const fundWith = params.fundWith ?? (quote.isNative ? "native" : "erc20");
  if (fundWith === "native" && !quote.isNative) {
    throw new RallyError(
      "INVALID_AMOUNT",
      `Native ETH funding is only valid for the wETH quote; ${quote.address} needs an ` +
        `ERC-20 approval to the factory (fundWith: "erc20").`,
      { details: { quote: quote.address, weth: addresses.weth } },
    );
  }

  // The token's CREATE2 address depends only on (LaunchLib, salt, initCodeHash), so
  // both reads happen once and the grind is pure-local from there.
  const [vanity, initCodeHash, deployer] = await Promise.all([
    readTokenVanity(client, factory),
    readContract(client, {
      address: factory,
      abi: rallyFactoryAbi,
      functionName: "tokenInitCodeHash",
      args: [name, symbol],
    }),
    // LaunchLib runs the `new RallyToken{salt}`, so it — not the factory — is the
    // CREATE2 `from`. Mining against the factory lands a non-vanity address and
    // reverts VanityMismatch. Read it rather than trusting the bundled manifest.
    readContract(client, { address: factory, abi: rallyFactoryAbi, functionName: "launchLib" }),
  ]);

  let salt: Hex;
  let token: Address;
  if (params.salt) {
    salt = params.salt;
    const bound = saltCreator(salt);
    if (bound.toLowerCase() !== creator.toLowerCase()) {
      throw new RallyError(
        "INVALID_SALT",
        `Salt is bound to ${bound}, but the launch is sent by ${creator}. ` +
          `Rebuild it with packSalt(creator, nonce).`,
        { details: { bound, creator } },
      );
    }
    token = await readContract(client, {
      address: factory,
      abi: rallyFactoryAbi,
      functionName: "predictToken",
      args: [salt, name, symbol],
    });
  } else {
    step("mining");
    const mined = await mineVanitySalt({
      deployer,
      creator,
      initCodeHash,
      vanity,
      ...params.mining,
    });
    salt = mined.salt;
    token = mined.address;
  }

  let metadataURI = selfHostedURI;
  if (!metadataURI) {
    const pin = params.pin ?? ctx.pin;
    if (!pin) {
      throw new RallyError(
        "METADATA_REQUIRED",
        "No metadata service configured. Pass `metadata: { endpoint }` to createRallyClient, " +
          "a `pin` callback on this launch, or supply your own `metadataURI`.",
      );
    }
    // Guaranteed by the check above — this branch means `metadataURI` was absent,
    // so `metadata` was supplied. Restated so the compiler sees a complete blob.
    if (!pinMetadata) {
      throw new RallyError(
        "METADATA_REQUIRED",
        "A launch needs either `metadata` or `metadataURI`.",
      );
    }
    step("pinning");
    metadataURI = await pin({
      chainId: addresses.chainId,
      tokenAddress: token,
      metadata: pinMetadata,
    });
  }

  // Approval only matters on the ERC-20 funding path; the native path attaches value.
  let approval: TxRequest | undefined;
  if (fundWith === "erc20" && totalCost > 0n) {
    const allowance = await readContract(client, {
      address: quote.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [creator, factory],
    });
    if (allowance < totalCost) {
      approval = {
        to: quote.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [factory, params.approveMax ? MAX_UINT256 : totalCost],
        }),
        value: 0n,
        chainId: addresses.chainId,
      };
    }
  }

  // The 6-arg overload defers to the governance DEFAULT_*_BPS on-chain, so omitting a
  // split gets the real default rather than one guessed off stale reads.
  const data = params.fees
    ? encodeFunctionData({
        abi: rallyFactoryAbi,
        functionName: "launch",
        args: [name, symbol, metadataURI, salt, quote.address, initialBuy, params.fees],
      })
    : encodeFunctionData({
        abi: rallyFactoryAbi,
        functionName: "launch",
        args: [name, symbol, metadataURI, salt, quote.address, initialBuy],
      });

  return {
    token,
    pid: poolIdOf(quote.address, token, addresses.launchHook),
    salt,
    creator,
    metadataURI,
    quote,
    launchFee: quote.launchFee,
    initialBuy,
    totalCost,
    fees: params.fees,
    fundWith,
    approval,
    request: {
      to: factory,
      data,
      value: fundWith === "native" ? totalCost : 0n,
      chainId: addresses.chainId,
    },
  };
}

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Parse a confirmed launch receipt. `Launched` is emitted by the HOOK, not the factory — a
 * pool's whole log stream has one source address — so that is what is matched here.
 *
 * The creator's first buy is read from `RallyFactory.FirstBuy`. It is NOT readable from the
 * v4 `Swap` the same buy triggers: a CURVE-phase fill is answered entirely by the hook's
 * `BeforeSwapDelta`, so v4 runs `Pool.swap` with `amountSpecified == 0`, moves no liquidity,
 * and emits `Swap` with BOTH legs zero. That is true of every curve trade — ordinary ones
 * escape it only because `RallyRouter` reports its own legs. Pass `factory` to have
 * `firstBuyTokens` populated; omit it and the field is simply absent.
 */
export function parseLaunchReceipt(
  receipt: TransactionReceipt,
  hook: Address,
  factory?: Address,
): Omit<LaunchResult, "receipt" | "transactionHash"> {
  if (receipt.status !== "success") {
    // A reverted transaction is still mined and still returns a receipt, so inclusion
    // alone is not success.
    throw new RallyError("LAUNCH_REVERTED", "The launch reverted on-chain.", {
      details: { transactionHash: receipt.transactionHash },
    });
  }

  let launched: LaunchResult | undefined;
  let firstBuyTokens: bigint | undefined;

  // Collected in a second pass: `FirstBuy` follows `Launched` in log order today, but
  // matching on `pid` needs `launched` first and this does not depend on that ordering.
  const firstBuys: { pid: Hex; amount0: bigint; amount1: bigint }[] = [];

  for (const log of receipt.logs) {
    const from = log.address.toLowerCase();
    if (factory !== undefined && from === factory.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: rallyFactoryAbi, data: log.data, topics: log.topics });
        if (d.eventName === "FirstBuy") {
          firstBuys.push({ pid: d.args.pid, amount0: d.args.amount0, amount1: d.args.amount1 });
        }
      } catch {
        // an unrelated factory event
      }
      continue;
    }
    if (from !== hook.toLowerCase()) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: rallyHookAbi, data: log.data, topics: log.topics });
    } catch {
      continue; // an unrelated event from the same address
    }
    if (decoded.eventName === "Launched") {
      const a = decoded.args;
      launched = {
        token: a.token,
        pid: a.pid,
        creator: a.creator,
        quote: a.quote,
        gradThreshold: a.gradThreshold,
        metadataURI: a.metadataURI,
      } as LaunchResult;
    }
  }

  if (!launched) {
    throw new RallyError(
      "LAUNCH_NOT_FOUND",
      `No Launched event from the hook (${hook}) in this receipt. Wrong chain, or a hook ` +
        `address mismatch between this SDK's manifest and the deployment.`,
      { details: { hook, transactionHash: receipt.transactionHash } },
    );
  }
  // `FirstBuy` legs follow v4's own convention — swapper-perspective and currency-ordered —
  // so the positive leg is what the creator received, which for a buy is always the token.
  for (const f of firstBuys) {
    if (f.pid !== launched.pid) continue;
    const received = f.amount0 > 0n ? f.amount0 : f.amount1;
    if (received > 0n) firstBuyTokens = received;
  }

  return firstBuyTokens === undefined ? launched : { ...launched, firstBuyTokens };
}

/** Re-export so integrators can build salts without importing an internal path. */
export { packSalt, saltCreator };
