/**
 * A single error type with a machine-readable `code`, so integrators can branch on
 * failures without string-matching messages. Anything thrown from below (viem RPC
 * errors, fetch failures) is wrapped with `cause` preserved.
 */
export type RallyErrorCode =
  | "UNSUPPORTED_CHAIN"
  | "MISSING_ADDRESS"
  | "NO_WALLET"
  | "NO_ACCOUNT"
  | "QUOTE_NOT_ALLOWED"
  | "INVALID_FEE_SPLIT"
  | "INVALID_SALT"
  | "MINING_FAILED"
  | "METADATA_REQUIRED"
  | "METADATA_FAILED"
  | "AUTH_FAILED"
  | "LAUNCH_NOT_FOUND"
  | "LAUNCH_REVERTED"
  | "GRADUATED"
  | "NO_PRICE"
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_BALANCE"
  | "NO_ETH_ROUTE"
  | "BAD_ETH_ROUTE"
  | "UNSUPPORTED";

export class RallyError extends Error {
  readonly code: RallyErrorCode;
  /** Extra context for the failure (addresses, amounts) — safe to log. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: RallyErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RallyError";
    this.code = code;
    this.details = options?.details;
  }
}

export function isRallyError(err: unknown): err is RallyError {
  return err instanceof RallyError;
}
