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
  /** An already-hosted metadata JSON. Mutually exclusive with `metadata`. */
  metadataURI?: string;
  /**
   * Metadata to pin through the configured service. Mutually exclusive with
   * `metadataURI`. `imageUrl` is required (upload one with `uploadImage`); `name`
   * and `symbol` default to this launch's own.
   */
  metadata?: LaunchMetadataParams;
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
 * The complete blob to pin, from what the caller supplied plus the launch's own
 * name and symbol.
 *
 * An explicit override wins, but only when it carries something: a blank `name` or
 * `symbol` would otherwise shadow the launch's own and pin a coin with no identity
 * on it. `imageUrl` is typed as required, but a JS caller can still omit it, so it
 * is checked rather than assumed.
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
  return {
    ...metadata,
    imageUrl: metadata.imageUrl.trim(),
    name: metadata.name?.trim() || name,
    symbol: metadata.symbol?.trim() || symbol,
  };
}

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
   * launch — so a pinner never has to re-derive them.
   */
  pin?: (input: {
    chainId: number;
    tokenAddress: Address;
    metadata: LaunchMetadata;
  }) => Promise<string>;
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
  // Resolved (and validated) before the salt grind: a missing logo should cost
  // nothing, not surface as an opaque 400 from the pinning service after minutes
  // of mining.
  const pinMetadata = params.metadata
    ? resolvePinMetadata(params.metadata, name, symbol)
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

  let metadataURI = params.metadataURI;
  if (!metadataURI) {
    if (!ctx.pin) {
      throw new RallyError(
        "METADATA_REQUIRED",
        "No metadata service configured. Pass `metadata: { endpoint }` to createRallyClient, " +
          "or supply your own `metadataURI`.",
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
    metadataURI = await ctx.pin({
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
 * Parse a confirmed launch receipt. `Launched` is emitted by the HOOK, not the
 * factory — a pool's whole log stream has one source address — so that is what is
 * matched here.
 */
export function parseLaunchReceipt(
  receipt: TransactionReceipt,
  hook: Address,
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

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== hook.toLowerCase()) continue;
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
    } else if (decoded.eventName === "FirstBuy") {
      // Swapper-perspective, currency-ordered: the positive leg is what the creator
      // received, which for a first buy is always the token side.
      const { amount0, amount1 } = decoded.args;
      const received = amount0 > 0n ? amount0 : amount1;
      if (received > 0n) firstBuyTokens = received;
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
  return firstBuyTokens === undefined ? launched : { ...launched, firstBuyTokens };
}

/** Re-export so integrators can build salts without importing an internal path. */
export { packSalt, saltCreator };
