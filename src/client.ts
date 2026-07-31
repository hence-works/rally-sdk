/**
 * `createRallyClient` — the one object an integrator holds.
 *
 * Every action comes in two forms:
 *
 *   - `prepare*` returns unsigned `{to, data, value}` and touches no signer, so a host
 *     on ethers, Privy, a Safe, or a backend key can submit it however it likes; and
 *   - the one-call form (`launch`, `swap`, …) drives the whole sequence — approve,
 *     send, wait, parse — against a viem wallet client.
 *
 * Reads never need a wallet. Writes never need Rally's backend: metadata pinning is
 * the only hosted dependency, and it is opt-out (bring your own `metadataURI`).
 */
import { type Address, type Hex, type TransactionReceipt } from "viem";
import { sendTransaction, waitForTransactionReceipt } from "viem/actions";
import { defaultEthRoute, requireFactory, resolveAddresses } from "./addresses";
import { RallyError } from "./errors";
import {
  parseLaunchReceipt,
  prepareLaunch as prepareLaunchInner,
  readQuoteConfig,
  readTokenVanity,
  validateFeeSplit,
  type LaunchParams,
  type LaunchResult,
  type PreparedLaunch,
} from "./launch";
import { cleanMetadata, createRallyPinner, type MetadataConfig, type MetadataPinner } from "./metadata";
import { createCache, readCurveParams, readFeePolicy } from "./params";
import {
  prepareEthBuy as prepareEthBuyInner,
  prepareSwap as prepareSwapInner,
  quoteTrade as quoteTradeInner,
  quoteTradeExactOut as quoteTradeExactOutInner,
  resolveLaunch,
  type PrepareEthBuyParams,
  type PrepareSwapParams,
  type PreparedSwap,
  type QuoteTradeParams,
} from "./trade";
import type {
  CurveParams,
  FeePolicy,
  LaunchState,
  PublicClientLike,
  QuoteConfig,
  RallyAddresses,
  SwapStep,
  TradeQuote,
  TxRequest,
  WalletClientLike,
} from "./types";

export interface RallyClientConfig {
  chainId: number;
  /** Any viem client with a transport — `createPublicClient`, or wagmi's. */
  publicClient: PublicClientLike;
  /** Needed only for the one-call helpers and for SIWE metadata pinning. */
  walletClient?: WalletClientLike;
  /** Address overrides, layered over the bundled manifest for this chain. */
  addresses?: Partial<RallyAddresses>;
  /**
   * Quote assets to consider when resolving a launch from a token address. Defaults to
   * the chain's wETH and USDC — add any newer allowlisted quote here.
   */
  quotes?: Address[];
  /** Rally's metadata service, or your own pinner. Omit to always bring your own URI. */
  metadata?: MetadataConfig | MetadataPinner;
  /** TTL for cached governance params. Default 60s; they sit behind a 48h timelock. */
  paramCacheMs?: number;
  /** wETH/<quote> v3 pools for ETH-funded buys, keyed by lowercased quote address. */
  ethRoutes?: Record<string, Address>;
}

export type RallyClient = ReturnType<typeof createRallyClient>;

export function createRallyClient(config: RallyClientConfig) {
  const addresses = resolveAddresses(config.chainId, config.addresses);
  const { publicClient, walletClient } = config;
  const ttl = config.paramCacheMs ?? 60_000;

  const pinner: MetadataPinner | undefined = config.metadata
    ? isPinner(config.metadata)
      ? config.metadata
      : createRallyPinner(config.metadata)
    : undefined;

  const curveParams = createCache<CurveParams>(ttl, () =>
    readCurveParams(publicClient, addresses.paramRegistry),
  );
  const feePolicy = createCache<FeePolicy>(ttl, () =>
    readFeePolicy(publicClient, addresses.paramRegistry),
  );

  // Quote configs are per-quote and rarely change, but they carry the launch fee, so
  // they get the same TTL rather than being cached forever.
  const quoteCache = new Map<string, { at: number; value: Promise<QuoteConfig> }>();
  function quoteConfig(quote: Address): Promise<QuoteConfig> {
    const key = quote.toLowerCase();
    const hit = quoteCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = readQuoteConfig(publicClient, requireFactory(addresses), quote, addresses.weth);
    quoteCache.set(key, { at: Date.now(), value });
    value.catch(() => quoteCache.delete(key));
    return value;
  }

  function account(): Address | undefined {
    return walletClient?.account?.address;
  }

  function requireWallet(): WalletClientLike {
    if (!walletClient) {
      throw new RallyError(
        "NO_WALLET",
        "This call sends a transaction — pass `walletClient` to createRallyClient, or use " +
          "the matching prepare* method and submit the request yourself.",
      );
    }
    if (!walletClient.account) {
      throw new RallyError("NO_ACCOUNT", "The wallet client has no account attached.");
    }
    return walletClient;
  }

  /** `"WETH"` / `"USDC"` / an explicit address → an address. */
  function resolveQuote(quote: LaunchParams["quote"]): Address {
    if (!quote || quote === "WETH") return addresses.weth;
    if (quote === "USDC") {
      if (!addresses.usdc) {
        throw new RallyError(
          "QUOTE_NOT_ALLOWED",
          `Chain ${addresses.chainId} has no USDC address in this SDK's manifest.`,
        );
      }
      return addresses.usdc;
    }
    return quote;
  }

  /** Send a prepared request and wait for it to be mined. */
  async function send(request: TxRequest): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    const wallet = requireWallet();
    const hash = await sendTransaction(wallet, {
      account: wallet.account!,
      chain: wallet.chain ?? null,
      to: request.to,
      data: request.data,
      value: request.value,
    });
    const receipt = await waitForTransactionReceipt(publicClient, { hash });
    return { hash, receipt };
  }

  return {
    /** The resolved contract set for this chain. */
    addresses,
    chainId: addresses.chainId,
    publicClient,
    walletClient,

    // ───────────────────────────── reads ─────────────────────────────

    /** Governance curve params (supply, allocation, fee decay, pool fee). Cached. */
    getCurveParams: curveParams,
    /** Governance fee policy (platform cut, creator cap, enabled mechanisms). Cached. */
    getFeePolicy: feePolicy,
    /** A quote's allowlist entry, launch fee and graduation threshold. Cached. */
    getQuoteConfig: quoteConfig,
    /** The factory's current address-vanity pattern. */
    getTokenVanity: () => readTokenVanity(publicClient, requireFactory(addresses)),

    /** Every quote this client will consider, resolved. */
    async listQuotes(): Promise<QuoteConfig[]> {
      const list = config.quotes ?? [addresses.weth, addresses.usdc].filter(Boolean);
      const configs = await Promise.all(list.map((q) => quoteConfig(q as Address)));
      return configs.filter((q) => q.allowed);
    },

    /**
     * Full on-chain state of a launch, found from just its token address: the SDK
     * derives the candidate PoolId for each known quote locally and asks the hook which
     * one exists, so no indexer is involved.
     */
    getLaunch(token: Address): Promise<LaunchState> {
      const candidates = (config.quotes ?? [addresses.weth, addresses.usdc].filter(Boolean)) as Address[];
      return resolveLaunch(publicClient, addresses, token, candidates, quoteConfig);
    },

    // ──────────────────────────── launching ────────────────────────────

    /** Validate a §6.1 fee split against live governance policy. */
    async validateFees(fees: Parameters<typeof validateFeeSplit>[0]): Promise<void> {
      validateFeeSplit(fees, await feePolicy());
    },

    /**
     * Resolve a launch end to end — quote economics, vanity salt, token address,
     * metadata — and return the unsigned transaction(s). Sends nothing.
     */
    prepareLaunch(params: LaunchParams): Promise<PreparedLaunch> {
      return prepareLaunchInner(
        {
          client: publicClient,
          addresses,
          factory: requireFactory(addresses),
          account: account(),
          feePolicy,
          resolveQuote,
          pin: pinner
            ? async ({ chainId, tokenAddress, metadata }) => {
                bindPinnerWallet(pinner);
                return pinner.pin({
                  chainId,
                  tokenAddress,
                  ...cleanMetadata(metadata),
                });
              }
            : undefined,
        },
        params,
      );
    },

    /**
     * Launch a coin: prepare, approve if needed, sign, wait, and parse the result.
     * Reverts surface as `LAUNCH_REVERTED` — a mined receipt is not success.
     */
    async launch(params: LaunchParams): Promise<LaunchResult & { prepared: PreparedLaunch }> {
      requireWallet();
      const step = params.onStep ?? (() => {});
      const prepared = await this.prepareLaunch(params);

      if (prepared.approval) {
        step("approving");
        const approval = await send(prepared.approval);
        if (approval.receipt.status !== "success") {
          throw new RallyError("LAUNCH_REVERTED", "The quote approval reverted.", {
            details: { transactionHash: approval.hash },
          });
        }
      }

      step("signing");
      const wallet = requireWallet();
      const hash = await sendTransaction(wallet, {
        account: wallet.account!,
        chain: wallet.chain ?? null,
        to: prepared.request.to,
        data: prepared.request.data,
        value: prepared.request.value,
      });

      step("confirming");
      const receipt = await waitForTransactionReceipt(publicClient, { hash });
      const parsed = parseLaunchReceipt(receipt, addresses.launchHook);
      return { ...parsed, transactionHash: hash, receipt, prepared };
    },

    /** Parse a launch receipt you submitted yourself. */
    parseLaunchReceipt(receipt: TransactionReceipt) {
      return parseLaunchReceipt(receipt, addresses.launchHook);
    },

    /** Wait for a launch transaction and parse it. */
    async waitForLaunch(hash: Hex): Promise<LaunchResult> {
      const receipt = await waitForTransactionReceipt(publicClient, { hash });
      return { ...parseLaunchReceipt(receipt, addresses.launchHook), transactionHash: hash, receipt };
    },

    /** Front-load the SIWE prompt (hosted pinner only), so it isn't mid-launch. */
    async authenticate(): Promise<string> {
      if (!pinner || !("authenticate" in pinner)) {
        throw new RallyError("AUTH_FAILED", "No hosted metadata service configured.");
      }
      const wallet = requireWallet();
      return (pinner as { authenticate: (ctx: unknown) => Promise<string> }).authenticate({
        address: wallet.account!.address,
        chainId: addresses.chainId,
        signMessage: (message: string) => signWith(wallet, message),
      });
    },

    /** Upload a logo through the hosted service and get its public URL. */
    async uploadImage(file: Blob | ArrayBuffer | Uint8Array, contentType: string): Promise<string> {
      if (!pinner?.uploadImage) {
        throw new RallyError(
          "METADATA_FAILED",
          "No metadata service configured with image upload support.",
        );
      }
      bindPinnerWallet(pinner);
      return pinner.uploadImage(file, contentType);
    },

    // ───────────────────────────── trading ─────────────────────────────

    /** Price an exact-input trade. Pure once the launch state is in hand. */
    async quote(token: Address, input: QuoteTradeParams): Promise<TradeQuote> {
      const [launch, params] = await Promise.all([this.getLaunch(token), curveParams()]);
      return quoteTradeInner(launch, params, input);
    },

    /** Price an exact-output trade (curve phase only). */
    async quoteExactOut(
      token: Address,
      input: Parameters<typeof quoteTradeExactOutInner>[2],
    ) {
      const [launch, params] = await Promise.all([this.getLaunch(token), curveParams()]);
      return quoteTradeExactOutInner(launch, params, input);
    },

    /** Build an unsigned swap (plus the approval it needs), without sending. */
    async prepareSwap(token: Address, input: PrepareSwapParams): Promise<PreparedSwap> {
      const [launch, params] = await Promise.all([this.getLaunch(token), curveParams()]);
      return prepareSwapInner(publicClient, addresses, launch, params, {
        trader: input.trader ?? account(),
        ...input,
      });
    },

    /** Buy or sell: approve if needed, sign, wait. */
    async swap(
      token: Address,
      input: PrepareSwapParams & { onStep?: (step: SwapStep) => void },
    ): Promise<{ hash: Hex; receipt: TransactionReceipt; quote: TradeQuote }> {
      requireWallet();
      const step = input.onStep ?? (() => {});
      step("quoting");
      const prepared = await this.prepareSwap(token, input);

      if (prepared.approval) {
        step("approving");
        const approval = await send(prepared.approval);
        if (approval.receipt.status !== "success") {
          throw new RallyError("LAUNCH_REVERTED", "The input-token approval reverted.", {
            details: { transactionHash: approval.hash },
          });
        }
      }

      step("signing");
      const wallet = requireWallet();
      const hash = await sendTransaction(wallet, {
        account: wallet.account!,
        chain: wallet.chain ?? null,
        to: prepared.request.to,
        data: prepared.request.data,
        value: prepared.request.value,
      });
      step("confirming");
      const receipt = await waitForTransactionReceipt(publicClient, { hash });
      return { hash, receipt, quote: prepared.quote };
    },

    /**
     * Buy a non-wETH-quoted launch with native ETH in one transaction (ETH → quote on a
     * Uniswap v3 pool → the curve). No approvals, no holding the quote asset.
     */
    async prepareEthBuy(token: Address, input: PrepareEthBuyParams) {
      const launch = await this.getLaunch(token);
      const route =
        config.ethRoutes?.[launch.quote.address.toLowerCase()] ??
        defaultEthRoute(addresses.chainId, launch.quote.address);
      return prepareEthBuyInner(publicClient, addresses, launch, input, route);
    },

    async ethBuy(token: Address, input: PrepareEthBuyParams) {
      const prepared = await this.prepareEthBuy(token, input);
      const { hash, receipt } = await send(prepared.request);
      return { ...prepared, hash, receipt };
    },

    /** Send any prepared request with the configured wallet. */
    send,
  };

  /** Give the hosted pinner the wallet it needs to mint a session on demand. */
  function bindPinnerWallet(target: MetadataPinner): void {
    if (!walletClient?.account || !("setAuthContext" in target)) return;
    const wallet = walletClient;
    (target as { setAuthContext: (ctx: unknown) => void }).setAuthContext({
      address: wallet.account!.address,
      chainId: addresses.chainId,
      signMessage: (message: string) => signWith(wallet, message),
    });
  }
}

/** `signMessage` through whatever wallet client shape the host passed in. */
async function signWith(wallet: WalletClientLike, message: string): Promise<`0x${string}`> {
  const signer = wallet as unknown as {
    signMessage?: (args: { account: unknown; message: string }) => Promise<`0x${string}`>;
  };
  if (typeof signer.signMessage !== "function") {
    throw new RallyError(
      "AUTH_FAILED",
      "The wallet client cannot signMessage, which SIWE sign-in requires. Pass " +
        "`metadata.token` instead, or bring your own metadataURI.",
    );
  }
  return signer.signMessage({ account: wallet.account, message });
}

function isPinner(value: MetadataConfig | MetadataPinner): value is MetadataPinner {
  return typeof (value as MetadataPinner).pin === "function";
}
