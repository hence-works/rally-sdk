import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/kit";
import { RallyError } from "../errors";
import { RALLY_SOLANA_PROTOCOL_IDL } from "./idl.generated";

/**
 * A small Borsh codec driven by the committed IDL (`idl.generated.ts`), so the program's
 * layouts are never hand-copied: regenerating the IDL re-flows every encoder and decoder.
 *
 * Why this instead of Codama-generated builders or a hand-written encoder per
 * instruction: the SDK needs eight instructions out of forty and four account layouts,
 * all of them built from a dozen primitives. Codama output would add a generated client
 * for the whole program plus its own codec runtime to every consumer's bundle, and
 * hand-written encoders would copy layouts that then drift silently when the program
 * changes (the exact failure the EVM side avoids by generating `deployments.ts`). The
 * IDL-driven codec is ~100 lines, adds nothing to the bundle but the trimmed IDL, and is
 * pinned by tests that build the bytes independently.
 */

type IdlType =
  | string
  | { vec: IdlType }
  | { option: IdlType }
  | { array: readonly [IdlType, number] }
  | { defined: { name: string } };

interface IdlStruct {
  name: string;
  kind: "struct";
  fields: readonly { name: string; type: IdlType }[];
}
interface IdlEnum {
  name: string;
  kind: "enum";
  variants: readonly string[];
}

const TYPES = new Map<string, IdlStruct | IdlEnum>(
  (RALLY_SOLANA_PROTOCOL_IDL.types as unknown as (IdlStruct | IdlEnum)[]).map((t) => [t.name, t]),
);

export const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const fail = (msg: string, details?: Record<string, unknown>): never => {
  throw new RallyError("INVALID_AMOUNT", msg, details ? { details } : undefined);
};

// ── Encoding ─────────────────────────────────────────────────────────────────

class Writer {
  private chunks: Uint8Array[] = [];
  push(b: Uint8Array) {
    this.chunks.push(b);
  }
  uint(value: bigint | number, bytes: number, label: string, signed = false) {
    let v = BigInt(value);
    const bits = BigInt(bytes * 8);
    const min = signed ? -(1n << (bits - 1n)) : 0n;
    const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    if (v < min || v > max) fail(`${label} out of range for ${signed ? "i" : "u"}${bytes * 8}: ${v}`, { label });
    if (v < 0n) v += 1n << bits;
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.push(out);
  }
  bytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

const INT_BYTES: Record<string, [number, boolean]> = {
  u8: [1, false],
  u16: [2, false],
  u32: [4, false],
  u64: [8, false],
  u128: [16, false],
  i8: [1, true],
  i16: [2, true],
  i32: [4, true],
  i64: [8, true],
  i128: [16, true],
};

function write(w: Writer, ty: IdlType, value: unknown, label: string): void {
  if (typeof ty === "string") {
    const int = INT_BYTES[ty];
    if (int) {
      if (typeof value !== "bigint" && typeof value !== "number") fail(`${label} must be a bigint or number`, { label });
      if (typeof value === "number" && !Number.isSafeInteger(value)) fail(`${label} must be a safe integer`, { label });
      return w.uint(value as bigint | number, int[0], label, int[1]);
    }
    if (ty === "bool") return w.push(Uint8Array.of(value ? 1 : 0));
    if (ty === "pubkey") return w.push(new Uint8Array(getAddressEncoder().encode(value as Address)));
    if (ty === "string") {
      const b = new TextEncoder().encode(String(value));
      w.uint(b.length, 4, label);
      return w.push(b);
    }
    throw new RallyError("UNSUPPORTED", `IDL type ${ty} is not supported by the codec`);
  }
  if ("option" in ty) {
    if (value === null || value === undefined) return w.push(Uint8Array.of(0));
    w.push(Uint8Array.of(1));
    return write(w, ty.option, value, label);
  }
  if ("vec" in ty) {
    const list = value as unknown[];
    w.uint(list.length, 4, label);
    list.forEach((v, i) => write(w, ty.vec, v, `${label}[${i}]`));
    return;
  }
  if ("array" in ty) {
    const [inner, n] = ty.array;
    const list = value as ArrayLike<unknown>;
    if (list.length !== n) fail(`${label} must have ${n} items`, { label });
    for (let i = 0; i < n; i++) write(w, inner, list[i], `${label}[${i}]`);
    return;
  }
  const def = TYPES.get(ty.defined.name);
  if (!def) throw new RallyError("UNSUPPORTED", `IDL type ${ty.defined.name} missing from the bundle`);
  if (def.kind === "enum") {
    const i = def.variants.indexOf(value as string);
    if (i < 0) fail(`${label} is not a ${def.name} variant`, { label });
    return w.push(Uint8Array.of(i));
  }
  const obj = value as Record<string, unknown>;
  for (const f of def.fields) write(w, f.type, obj[camel(f.name)], `${label}.${camel(f.name)}`);
}

/** Borsh-encode `args` against an instruction's IDL argument list (camelCase keys). */
export function encodeArgs(
  args: readonly { name: string; type: IdlType }[],
  values: Record<string, unknown>,
): Uint8Array {
  const w = new Writer();
  for (const a of args) write(w, a.type, values[camel(a.name)], camel(a.name));
  return w.bytes();
}

// ── Decoding ─────────────────────────────────────────────────────────────────

class Reader {
  o = 0;
  constructor(readonly d: Uint8Array) {}
  take(n: number): Uint8Array {
    if (this.o + n > this.d.length) {
      throw new RallyError("INVALID_ACCOUNT_DATA", `Account data ended ${this.o + n - this.d.length} bytes early`);
    }
    const out = this.d.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  uint(bytes: number, signed: boolean): bigint {
    const b = this.take(bytes);
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    if (signed && v >= 1n << BigInt(bytes * 8 - 1)) v -= 1n << BigInt(bytes * 8);
    return v;
  }
}

function read(r: Reader, ty: IdlType): unknown {
  if (typeof ty === "string") {
    const int = INT_BYTES[ty];
    if (int) {
      const v = r.uint(int[0], int[1]);
      // Up to 32 bits is a plain number; u64/u128/i64 stay bigint end to end.
      return int[0] <= 4 ? Number(v) : v;
    }
    if (ty === "bool") return r.take(1)[0] !== 0;
    if (ty === "pubkey") return getAddressDecoder().decode(r.take(32));
    if (ty === "string") {
      const n = Number(r.uint(4, false));
      return new TextDecoder().decode(r.take(n));
    }
    throw new RallyError("UNSUPPORTED", `IDL type ${ty} is not supported by the codec`);
  }
  if ("option" in ty) return r.take(1)[0] === 0 ? null : read(r, ty.option);
  if ("vec" in ty) {
    const n = Number(r.uint(4, false));
    return Array.from({ length: n }, () => read(r, ty.vec));
  }
  if ("array" in ty) {
    const [inner, n] = ty.array;
    if (inner === "u8") return Uint8Array.from(r.take(n));
    return Array.from({ length: n }, () => read(r, inner));
  }
  const def = TYPES.get(ty.defined.name);
  if (!def) throw new RallyError("UNSUPPORTED", `IDL type ${ty.defined.name} missing from the bundle`);
  if (def.kind === "enum") {
    const i = r.take(1)[0]!;
    const v = def.variants[i];
    if (v === undefined) throw new RallyError("UNSUPPORTED", `Unknown ${def.name} variant ${i}`);
    return v;
  }
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    const v = read(r, f.type);
    // Reserved padding carries no information and would only bloat the public type.
    if (f.name !== "reserved") out[camel(f.name)] = v;
  }
  return out;
}

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Decode an account of IDL type `name`, checking its 8-byte Anchor discriminator first so
 * a wrong account (another program's, or another type) fails loudly instead of decoding
 * into plausible garbage.
 */
export function decodeAccount<T>(name: string, data: Uint8Array): T {
  const acc = RALLY_SOLANA_PROTOCOL_IDL.accounts.find((a) => a.name === name);
  if (!acc) throw new RallyError("UNSUPPORTED", `No ${name} account in the bundled IDL`);
  const want = hex(acc.discriminator);
  if (data.length < 8 || hex(data.subarray(0, 8)) !== want) {
    throw new RallyError("INVALID_ACCOUNT_DATA", `Not a ${name} account (discriminator mismatch)`, {
      details: { expected: want, got: hex(data.subarray(0, 8)) },
    });
  }
  return read(new Reader(data.subarray(8)), { defined: { name } }) as T;
}
