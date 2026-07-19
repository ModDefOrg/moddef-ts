// SPDX-License-Identifier: Apache-2.0

/**
 * Point decoder (spec §8–§15). Faithful port of go/codec/decode.go, including
 * selector_ref case application (§10.5) — kept in lockstep with the Go codec.
 */

import {
  ByteOrder,
  DateTimeEncoding,
  PrimitiveType,
  ScaleMode,
  StorageType,
  Termination,
  Padding,
  WordOrder,
  type ComposedMapping,
  type FlagSet,
  type Mapping,
  type Point,
  type StringEncoding,
} from "../schema/index.js";
import { DecodeError } from "../errors.js";
import { Unavailable, type DecodedValue, type FieldValues } from "../values.js";
import { assemble, decodeUint, lastN, maskFor, signExtend } from "./bytes.js";
import * as R from "./rat.js";

/**
 * Cross-point data needed during decode: integer values of the points
 * referenced by scale_ref / selector_ref (spec §10.4/§10.5).
 */
export interface CodecContext {
  refs: Map<string, bigint>;
}

export function emptyContext(): CodecContext {
  return { refs: new Map() };
}

function ref(ctx: CodecContext | undefined, id: string): bigint | undefined {
  return ctx?.refs.get(id);
}

/** Decode the registers for a point into a typed value. */
export function decodePoint(
  p: Point,
  regs: ArrayLike<number>,
  ctx?: CodecContext,
): DecodedValue {
  const m = p.mapping;

  // Composed (mantissa * base^exponent) decodes from sub-mappings (§14).
  if (p.storageType === StorageType.COMPOSED || m?.composed) {
    return decodeComposed(p, m?.composed, regs);
  }

  const byteBig = m?.byteOrder !== ByteOrder.LITTLE_ENDIAN;
  const wordBig = m?.wordOrder !== WordOrder.WORD_LITTLE_ENDIAN;
  const bytes = assemble(regs, byteBig, wordBig);

  // Flag sets: names of set bits (§13.2).
  const flags = p.valueType?.kind.case === "flags" ? p.valueType.kind.value : undefined;
  if (flags) return decodeFlags(bytes, flags);

  // Bit / register fields: decode each sub-field from the window (§13).
  if (p.fields.length > 0 || p.bitFields.length > 0) return decodeFields(p, bytes);

  const st = p.storageType;

  // Strings / raw bytes (§15).
  if (st === StorageType.STRING_ASCII || st === StorageType.STRING_UTF8) {
    return decodeString(bytes, m?.stringEncoding);
  }
  if (st === StorageType.BYTES_RAW) return bytes.slice();

  // Floats decode straight from IEEE bytes.
  if (st === StorageType.IEEE754_F32) {
    const dv = new DataView(lastN(bytes, 4).slice().buffer);
    return applyFloatScale(dv.getFloat32(0, false), p);
  }
  if (st === StorageType.IEEE754_F64) {
    const dv = new DataView(lastN(bytes, 8).slice().buffer);
    return applyFloatScale(dv.getFloat64(0, false), p);
  }

  // Integer-backed value.
  const bits = storageBits(st, regs.length);
  let raw = decodeUint(bytes);
  if (bits < 64) raw &= (1n << BigInt(bits)) - 1n;

  // Sentinel / unavailable check on the raw integer (§8.4).
  for (const na of p.naValues) {
    if ((BigInt.asUintN(64, na.raw) & maskFor(bits)) === (raw & maskFor(bits))) {
      return new Unavailable(na.meaning);
    }
  }

  if (st === StorageType.BCD) return Number(bcdToInt(bytes));

  const signed = isSigned(st);
  const rawInt = signed ? signExtend(raw, bits) : BigInt.asIntN(64, raw);

  const prim =
    p.valueType?.kind.case === "primitive" ? p.valueType.kind.value : PrimitiveType.PRIMITIVE_TYPE_UNSPECIFIED;

  switch (prim) {
    case PrimitiveType.BOOL:
      return raw !== 0n;
    case PrimitiveType.DATETIME:
      return decodeDateTime(raw, p);
    case PrimitiveType.DECIMAL:
    case PrimitiveType.FLOAT32:
    case PrimitiveType.FLOAT64:
      return applyScale(signed ? rawInt : raw, p, ctx);
    case PrimitiveType.UINT64:
      return raw;
    case PrimitiveType.INT64:
      return signed ? rawInt : BigInt.asIntN(64, raw);
    case PrimitiveType.UINT32:
      return Number(raw);
    case PrimitiveType.INT32:
      return Number(signed ? rawInt : raw);
    default:
      // No primitive declared (e.g. enum_ref) — return the raw integer; the
      // caller maps it via the referenced enum. Signed if the storage is.
      return Number(signed ? rawInt : raw);
  }
}

/** Pre-scale integer view for callers that need exactness (billing counters). */
export function decodePointRaw(p: Point, regs: ArrayLike<number>): { raw: bigint; bits: number } {
  const m = p.mapping;
  const byteBig = m?.byteOrder !== ByteOrder.LITTLE_ENDIAN;
  const wordBig = m?.wordOrder !== WordOrder.WORD_LITTLE_ENDIAN;
  const bytes = assemble(regs, byteBig, wordBig);
  const bits = storageBits(p.storageType, regs.length);
  let raw = decodeUint(bytes);
  if (bits < 64) raw &= (1n << BigInt(bits)) - 1n;
  return { raw, bits };
}

/** Apply the §10 transform (static rational or register-referenced) + offset. */
function applyScale(rawInt: bigint, p: Point, ctx?: CodecContext): number {
  let r = R.rat(rawInt);

  // §10.5: value/scale/unit selected by another register.
  const sel = p.selectorRef;
  if (sel) {
    const key = ref(ctx, sel.pointId);
    if (key !== undefined) {
      const c = sel.cases[key.toString()];
      if (c) {
        if (c.scale && c.scale.denominator !== 0n) {
          r = R.mul(r, R.rat(c.scale.numerator, c.scale.denominator));
        }
        if (c.offset && c.offset.denominator !== 0n) {
          r = R.add(r, R.rat(c.offset.numerator, c.offset.denominator));
        }
        return R.toNumber(r);
      }
    }
  }

  const t = p.transform;
  if (!t) return R.toNumber(r);

  if (t.scaleRef) {
    const sf = ref(ctx, t.scaleRef.pointId);
    if (sf === undefined) {
      throw new DecodeError(p.pointId, `scale_ref "${t.scaleRef.pointId}" not resolved in context`);
    }
    if (t.scaleRef.mode === ScaleMode.MULTIPLY) {
      const den = t.scaleRef.denominator === 0n ? 1n : t.scaleRef.denominator;
      r = R.mul(r, R.rat(sf, den));
    } else {
      r = R.mul(r, R.pow10(sf));
    }
  } else if (t.scale) {
    if (t.scale.denominator === 0n) throw new DecodeError(p.pointId, "scale denominator is zero");
    r = R.mul(r, R.rat(t.scale.numerator, t.scale.denominator));
  }

  if (t.offset && t.offset.denominator !== 0n) {
    r = R.add(r, R.rat(t.offset.numerator, t.offset.denominator));
  }
  return R.toNumber(r);
}

function applyFloatScale(f: number, p: Point): number {
  const t = p.transform;
  if (!t) return f;
  if (t.scale && t.scale.denominator !== 0n) {
    f = (f * Number(t.scale.numerator)) / Number(t.scale.denominator);
  }
  if (t.offset && t.offset.denominator !== 0n) {
    f += Number(t.offset.numerator) / Number(t.offset.denominator);
  }
  return f;
}

function decodeComposed(p: Point, c: ComposedMapping | undefined, regs: ArrayLike<number>): number {
  if (!c) throw new DecodeError(p.pointId, "composed mapping missing");
  if (c.base === 0n) throw new DecodeError(p.pointId, "composed base is zero");
  const mant = decodeSubInt(c.mantissa, regs);
  const exp = decodeSubInt(c.exponent, regs);
  let r = R.rat(mant);
  const b = R.rat(c.base);
  if (exp >= 0n) {
    for (let i = 0n; i < exp; i++) r = R.mul(r, b);
  } else {
    for (let i = 0n; i < -exp; i++) r = R.div(r, b);
  }
  return R.toNumber(r);
}

/**
 * Integer from a sub-mapping's registers within the supplied window. A bit
 * window (bit_length > 0) selects [bit_offset, bit_offset+bit_length) of the
 * assembled window and sign-extends from bit_length — the §14.2 embedded
 * decade exponent, where mantissa and exponent share a word (Iskra T5/T6,
 * Eaton PXM). Signedness comes from the sub-mapping's storage_type; absent
 * one, the value is signed (the pre-v0.5 behavior).
 */
function decodeSubInt(m: Mapping | undefined, regs: ArrayLike<number>): bigint {
  if (!m) return 0n;
  const idx = m.offset;
  const n = m.lengthWords || 1;
  if (idx + n > regs.length) return 0n;
  const byteBig = m.byteOrder !== ByteOrder.LITTLE_ENDIAN;
  const wordBig = m.wordOrder !== WordOrder.WORD_LITTLE_ENDIAN;
  const slice: number[] = [];
  for (let i = idx; i < idx + n; i++) slice.push((regs[i] ?? 0) & 0xffff);
  let raw = decodeUint(assemble(slice, byteBig, wordBig));

  const st = m.storageType;
  let bits = n * 16;
  if (st !== StorageType.STORAGE_TYPE_UNSPECIFIED) bits = storageBits(st, n);
  if (m.bitLength > 0) {
    raw = (raw >> BigInt(m.bitOffset)) & maskFor(m.bitLength);
    bits = m.bitLength;
  }
  if (st === StorageType.STORAGE_TYPE_UNSPECIFIED || isSigned(st)) {
    return signExtend(raw, bits);
  }
  if (bits < 64) raw &= maskFor(bits);
  return raw;
}

function decodeFlags(bytes: Uint8Array, fl: FlagSet): readonly string[] {
  const raw = decodeUint(bytes);
  const bits = Object.keys(fl.bits)
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);
  const out: string[] = [];
  for (const bit of bits) {
    if (raw & (1n << BigInt(bit))) out.push(fl.bits[bit]!);
  }
  return out;
}

function decodeFields(p: Point, bytes: Uint8Array): FieldValues {
  const raw = decodeUint(bytes);
  const out: { [k: string]: number } = {};
  const extract = (off: number, length: number): number => {
    const mask = (1n << BigInt(length)) - 1n;
    return Number((raw >> BigInt(off)) & mask);
  };
  for (const f of p.bitFields) out[f.fieldId] = extract(f.bitOffset, f.bitLength);
  for (const f of p.fields) out[f.fieldId] = extract(f.bitOffset, f.bitLength);
  return out;
}

function decodeString(bytes: Uint8Array, enc: StringEncoding | undefined): string {
  let end = bytes.length;
  if (enc?.termination === Termination.NULL_TERMINATED) {
    const i = bytes.indexOf(0);
    if (i >= 0) end = i;
  }
  let b = bytes.subarray(0, end);
  const pad = enc?.padding;
  if (pad === Padding.NULL) b = trimRight(b, 0);
  else if (pad === Padding.SPACE) b = trimRight(b, 0x20);
  return new TextDecoder().decode(b);
}

function decodeDateTime(raw: bigint, p: Point): Date {
  if (p.datetime?.encoding === DateTimeEncoding.EPOCH_MS) {
    return new Date(Number(BigInt.asIntN(64, raw)));
  }
  // EPOCH_S and unspecified (matches Go's default branch).
  return new Date(Number(BigInt.asIntN(64, raw)) * 1000);
}

// --- low-level helpers ---------------------------------------------------- //

function bcdToInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) {
    const hi = BigInt(x >> 4);
    const lo = BigInt(x & 0x0f);
    v = v * 100n + hi * 10n + lo;
  }
  return v;
}

export function storageBits(st: StorageType, words: number): number {
  switch (st) {
    case StorageType.BIT:
      return 1;
    case StorageType.U16:
    case StorageType.S16:
      return 16;
    case StorageType.U24:
      return 24;
    case StorageType.U32:
    case StorageType.S32:
      return 32;
    case StorageType.U48:
    case StorageType.S48:
      return 48;
    case StorageType.U64:
    case StorageType.S64:
      return 64;
    default:
      if (words <= 0) return 16;
      return Math.min(words * 16, 64);
  }
}

export function isSigned(st: StorageType): boolean {
  return (
    st === StorageType.S16 ||
    st === StorageType.S32 ||
    st === StorageType.S48 ||
    st === StorageType.S64
  );
}

function trimRight(b: Uint8Array, c: number): Uint8Array {
  let end = b.length;
  while (end > 0 && b[end - 1] === c) end--;
  return b.subarray(0, end);
}
