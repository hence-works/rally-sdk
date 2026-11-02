/**
 * Creator-fee NFT: `RallyFeeBeneficiary`, one ERC-721 per hook, token id = pool id.
 *
 * `claimCreatorFees` pays the NFT's holder, or the original creator while the launch is
 * unregistered. So the right to a coin's creator fees can be sold, split or recovered by moving
 * the NFT, and registering (a permissionless mint to the recorded creator) is what opts a launch in.
 *
 * Only protocol-v2 hooks have a beneficiary. A v1 coin always pays its original creator, and
 * these helpers say so (`supported: false`) rather than guessing.
 */
import { encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { readContract, sendTransaction, waitForTransactionReceipt } from "viem/actions";
import { rallyFeeBeneficiaryAbi } from "./abis";
import { generationForHook, resolveAddresses } from "./addresses";
import { RallyError } from "./errors";
import type { PublicClientLike, RallyAddresses, TxRequest, WalletClientLike } from "./types";

export interface FeeBeneficiaryTarget {
  chainId: number;
  /** The coin's hook (`LaunchState.hook`): its generation decides which beneficiary contract applies. */
  hook?: Address;
  /** Alternative to `hook`: anything carrying the coin's hook, e.g. a resolved launch. */
  launch?: { hook?: Address };
  /** Bundled addresses are layered under these, as in `createRallyClient({ addresses })`. */
  addresses?: Partial<RallyAddresses>;
}

export type FeeBeneficiaryRead =
  | { supported: false; reason: string }
  | {
      supported: true;
      beneficiary: Address;
      registered: boolean;
      /** Who `claimCreatorFees` pays: the NFT holder. Null while unregistered (it pays the original creator). */
      holder: Address | null;
    };

type Resolved = { beneficiary: Address } | { unsupported: string };

function resolve(t: FeeBeneficiaryTarget): Resolved {
  const hook = t.hook ?? t.launch?.hook;
  if (!hook) {
    throw new RallyError("MISSING_ADDRESS", "Pass the coin's `hook` (or a `launch` carrying it): the beneficiary is per hook generation.");
  }
  const gen = generationForHook(resolveAddresses(t.chainId, t.addresses), hook);
  if (!gen) {
    throw new RallyError("UNSUPPORTED", `Hook ${hook} is not a known generation on chain ${t.chainId}.`, {
      details: { chainId: t.chainId, hook },
    });
  }
  if (gen.protocolVersion !== 2) {
    return { unsupported: "Protocol-v1 hooks have no fee beneficiary: creator fees always go to the original creator." };
  }
  if (!gen.feeBeneficiary) {
    return { unsupported: "This SDK's bundled manifest records no fee beneficiary for that hook." };
  }
  return { beneficiary: gen.feeBeneficiary };
}

function requireBeneficiary(t: FeeBeneficiaryTarget): Address {
  const r = resolve(t);
  if ("unsupported" in r) throw new RallyError("UNSUPPORTED", r.unsupported, { details: { chainId: t.chainId } });
  return r.beneficiary;
}

const tx = (chainId: number, to: Address, data: Hex): TxRequest => ({ to, data, value: 0n, chainId });

/**
 * Who holds title to `pid`'s creator fees. One `beneficiaryOf` call; the retired pre-rename 4663
 * build answers it too (it is the only function this reads).
 */
export async function getFeeBeneficiary(
  client: PublicClientLike,
  p: FeeBeneficiaryTarget & { pid: Hex },
): Promise<FeeBeneficiaryRead> {
  const r = resolve(p);
  if ("unsupported" in r) return { supported: false, reason: r.unsupported };
  const holder = await readContract(client, {
    address: r.beneficiary,
    abi: rallyFeeBeneficiaryAbi,
    functionName: "beneficiaryOf",
    args: [p.pid],
  });
  const registered = holder !== zeroAddress;
  return { supported: true, beneficiary: r.beneficiary, registered, holder: registered ? holder : null };
}

/**
 * Unsigned `register(pid)`. Permissionless: it always mints to the creator the hook recorded,
 * whoever sends it, so registering on someone's behalf is a favour, not an attack. Reverts
 * `AlreadyRegistered` / `UnknownPool` on chain.
 */
export function prepareRegisterFeeBeneficiary(p: FeeBeneficiaryTarget & { pid: Hex }): TxRequest {
  const to = requireBeneficiary(p);
  return tx(p.chainId, to, encodeFunctionData({ abi: rallyFeeBeneficiaryAbi, functionName: "register", args: [p.pid] }));
}

/**
 * Unsigned transfer of the fee right. Defaults to ERC-721 `safeTransferFrom(from, to, id)`.
 *
 * `to` may be a contract (a splitter, a Safe, an escrow) provided it implements
 * `onERC721Received`; otherwise a safe transfer reverts. For a contract that cannot receive
 * safely but is known to handle the NFT, pass `safe: false` for plain `transferFrom`, which skips
 * the receiver check (and so can strand the NFT in a contract that cannot move it: use with care).
 * The signer must be `from` or an approved operator.
 */
export function prepareTransferFeeRight(
  p: FeeBeneficiaryTarget & { pid: Hex; from: Address; to: Address; safe?: boolean },
): TxRequest {
  const to = requireBeneficiary(p);
  const id = BigInt(p.pid);
  const data =
    p.safe === false
      ? encodeFunctionData({ abi: rallyFeeBeneficiaryAbi, functionName: "transferFrom", args: [p.from, p.to, id] })
      : encodeFunctionData({ abi: rallyFeeBeneficiaryAbi, functionName: "safeTransferFrom", args: [p.from, p.to, id] });
  return tx(p.chainId, to, data);
}

interface Wire {
  publicClient: PublicClientLike;
  walletClient?: WalletClientLike;
}

function requireWallet(w: Wire): void {
  if (!w.walletClient) {
    throw new RallyError(
      "NO_WALLET",
      "This call sends a transaction: pass a `walletClient`, or use the matching prepare* function and submit it yourself.",
    );
  }
}

async function send(w: Wire, request: TxRequest) {
  requireWallet(w);
  if (!w.walletClient!.account) throw new RallyError("NO_ACCOUNT", "The wallet client has no account attached.");
  const wallet = w.walletClient!;
  const hash = await sendTransaction(wallet, {
    account: wallet.account!,
    chain: wallet.chain ?? null,
    to: request.to,
    data: request.data,
    value: request.value,
  });
  const receipt = await waitForTransactionReceipt(w.publicClient, { hash });
  return { hash, receipt };
}

/** Send `register(pid)` and wait for it. `NO_WALLET` without a wallet client. */
export async function registerFeeBeneficiary(w: Wire, p: FeeBeneficiaryTarget & { pid: Hex }) {
  return send(w, prepareRegisterFeeBeneficiary(p));
}

/** Send the fee-right transfer from the wallet's own account and wait for it. `NO_WALLET` without a wallet client. */
export async function transferFeeRight(
  w: Wire,
  p: Omit<Parameters<typeof prepareTransferFeeRight>[0], "from"> & { from?: Address },
) {
  requireWallet(w);
  const from = p.from ?? w.walletClient?.account?.address;
  if (!from) throw new RallyError("NO_ACCOUNT", "The wallet client has no account attached.");
  return send(w, prepareTransferFeeRight({ ...p, from: getAddress(from) }));
}
