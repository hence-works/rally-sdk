/** Server-to-server contract for partners receiving Rally trading signals. */
import { isAddress, isHex, type Address, type Hex } from "viem";

export const RALLY_PARTNER_TIMESTAMP_HEADER = "X-Rally-Timestamp";
export const RALLY_PARTNER_SIGNATURE_HEADER = "X-Rally-Signature";
export const RALLY_PARTNER_SIGNATURE_PREFIX = "sha256=";
export const RALLY_PARTNER_REPLAY_WINDOW_SECONDS = 60;
export const RALLY_PARTNER_SIGNAL_KINDS = ["ENTER", "TRIM", "EXIT", "CANCEL"] as const;
export const RALLY_PARTNER_SIGNAL_PHASES = ["CURVE", "GRADUATED"] as const;

export type RallyPartnerSignalKind = (typeof RALLY_PARTNER_SIGNAL_KINDS)[number];
export type RallyPartnerSignalPhase = (typeof RALLY_PARTNER_SIGNAL_PHASES)[number];

export interface RallyPartnerSignalBase {
  signalId: string;
  kind: RallyPartnerSignalKind;
  chainId: number;
  token: Address;
  pid: Hex;
  quote: Address;
  quoteDecimals: number;
  phase: RallyPartnerSignalPhase;
  /** Decimal string from 0 through 1. */
  score: string;
  reasons: string[];
  observedBlock: number;
  /** Unix seconds. */
  expiresAt: number;
  /** Aggregate cap across all partner accounts, in quote-token base units. */
  maxAggregateQuote: string;
}

export type RallyPartnerSignal =
  | (RallyPartnerSignalBase & {
      kind: "TRIM";
      trimBps: number;
      targetSignalId?: never;
    })
  | (RallyPartnerSignalBase & {
      kind: "ENTER" | "EXIT";
      trimBps?: never;
      targetSignalId?: never;
    })
  | (RallyPartnerSignalBase & {
      kind: "CANCEL";
      trimBps?: never;
      targetSignalId: string;
    });

export interface SignRallyPartnerWebhookOptions {
  /** Exact wire bytes. A string is encoded as UTF-8 without JSON normalization. */
  body: string | Uint8Array;
  secret: string | Uint8Array;
  /** Exact canonical value sent in X-Rally-Timestamp. */
  timestamp: string;
}

export interface VerifyRallyPartnerWebhookOptions extends SignRallyPartnerWebhookOptions {
  signature: string;
  /** Test/clock-injection hook. Defaults to the current Unix time in seconds. */
  nowSeconds?: number;
}

const CANONICAL_TIMESTAMP = /^(?:0|[1-9]\d*)$/;
const CANONICAL_SIGNATURE = /^sha256=([0-9a-f]{64})$/;

function bytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
}

function canonicalTimestamp(value: string): bigint {
  if (!CANONICAL_TIMESTAMP.test(value)) {
    throw new TypeError("partner webhook timestamp must be canonical decimal Unix seconds");
  }
  return BigInt(value);
}

function signedBytes(timestamp: string, body: string | Uint8Array): Uint8Array<ArrayBuffer> {
  canonicalTimestamp(timestamp);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const bodyBytes = bytes(body);
  const value = new Uint8Array(prefix.length + bodyBytes.length);
  value.set(prefix);
  value.set(bodyBytes, prefix.length);
  return value;
}

async function hmacKey(secret: string | Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  const secretBytes = bytes(secret);
  if (secretBytes.length === 0) throw new TypeError("partner webhook secret must not be empty");
  return crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

/** HMAC-SHA256 over exact bytes `timestamp + "." + rawBody`. */
export async function signRallyPartnerWebhook(
  options: SignRallyPartnerWebhookOptions,
): Promise<string> {
  const digest = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(options.secret, "sign"),
    signedBytes(options.timestamp, options.body),
  );
  return `${RALLY_PARTNER_SIGNATURE_PREFIX}${hex(digest)}`;
}

/** Verify the authenticated timestamp/body envelope before parsing the body. */
export async function verifyRallyPartnerWebhook(
  options: VerifyRallyPartnerWebhookOptions,
): Promise<boolean> {
  if (!CANONICAL_TIMESTAMP.test(options.timestamp)) return false;
  const signature = CANONICAL_SIGNATURE.exec(options.signature);
  if (!signature) return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(now) || now < 0) return false;
  const timestamp = BigInt(options.timestamp);
  const current = BigInt(now);
  const skew = timestamp > current ? timestamp - current : current - timestamp;
  if (skew > BigInt(RALLY_PARTNER_REPLAY_WINDOW_SECONDS)) return false;

  // WebCrypto performs the MAC comparison without exposing a timing-sensitive string loop.
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(options.secret, "verify"),
    unhex(signature[1]!),
    signedBytes(options.timestamp, options.body),
  );
}

function int(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError(`${field} must be an integer from ${min} through ${max}`);
  }
  return value as number;
}

function addr(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new TypeError(`${field} must be an EVM address`);
  }
  return value as Address;
}

/** Validate untrusted JSON without coercing amount strings into unsafe numbers. */
export function parseRallyPartnerSignal(value: unknown): RallyPartnerSignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("partner signal must be an object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.signalId !== "string" || !v.signalId) throw new TypeError("signalId is required");
  if (!(RALLY_PARTNER_SIGNAL_KINDS as readonly unknown[]).includes(v.kind)) {
    throw new TypeError("kind must be ENTER, TRIM, EXIT or CANCEL");
  }
  if (!(RALLY_PARTNER_SIGNAL_PHASES as readonly unknown[]).includes(v.phase)) {
    throw new TypeError("phase must be CURVE or GRADUATED");
  }
  if (typeof v.pid !== "string" || !isHex(v.pid) || v.pid.length !== 66) {
    throw new TypeError("pid must be a 32-byte hex string");
  }
  if (typeof v.score !== "string" || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(v.score)) {
    throw new TypeError("score must be a decimal string from 0 through 1");
  }
  if (
    !Array.isArray(v.reasons) ||
    v.reasons.some(
      (reason) => typeof reason !== "string" || reason.length === 0 || /[\r\n]/.test(reason),
    )
  ) {
    throw new TypeError("each reason must be one non-empty line");
  }
  if (typeof v.maxAggregateQuote !== "string" || !/^(?:0|[1-9]\d*)$/.test(v.maxAggregateQuote)) {
    throw new TypeError("maxAggregateQuote must be a non-negative base-unit integer string");
  }
  const kind = v.kind as RallyPartnerSignalKind;
  if (kind === "TRIM") int(v.trimBps, "trimBps", 1, 10_000);
  else if (v.trimBps !== undefined) throw new TypeError("trimBps is only valid on TRIM signals");
  if (kind === "CANCEL") {
    if (typeof v.targetSignalId !== "string" || v.targetSignalId.length === 0) {
      throw new TypeError("targetSignalId is required on CANCEL signals");
    }
    if (v.targetSignalId === v.signalId) {
      throw new TypeError("targetSignalId must differ from signalId");
    }
  } else if (v.targetSignalId !== undefined) {
    throw new TypeError("targetSignalId is only valid on CANCEL signals");
  }
  return {
    signalId: v.signalId,
    kind,
    chainId: int(v.chainId, "chainId", 1),
    token: addr(v.token, "token"),
    pid: v.pid as Hex,
    quote: addr(v.quote, "quote"),
    quoteDecimals: int(v.quoteDecimals, "quoteDecimals", 0, 18),
    phase: v.phase as RallyPartnerSignalPhase,
    score: v.score,
    reasons: v.reasons as string[],
    observedBlock: int(v.observedBlock, "observedBlock"),
    expiresAt: int(v.expiresAt, "expiresAt"),
    maxAggregateQuote: v.maxAggregateQuote,
    ...(kind === "TRIM" ? { trimBps: v.trimBps as number } : {}),
    ...(kind === "CANCEL" ? { targetSignalId: v.targetSignalId as string } : {}),
  } as RallyPartnerSignal;
}
