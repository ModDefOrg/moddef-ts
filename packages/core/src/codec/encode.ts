// SPDX-License-Identifier: Apache-2.0

/**
 * Point encoder (spec §10 inverse, §11.5 write encoding). Port of
 * go/codec/encode.go. Composed values, register-field structs, and
 * selector_ref remain read-oriented and are not supported for encode.
 */

import {
  ByteOrder,
  DateTimeEncoding,
  PrimitiveType,
  ScaleMode,
  StorageType,
  WordOrder,
  type FlagSet,
  type Point,
} from "../schema/index.js";
import { EncodeError } from "../errors.js";
import { bytesToWords, maskFor, padBytes, uintToWords } from "./bytes.js";
import * as R from "./rat.js";
import { storageBits, type CodecContext } from "./decode.js";

export type EncodableValue =
  | number
  | bigint
  | boolean
  | string
  | readonly string[]
  | Uint8Array
  | Date;

/** Serialize a typed value into register words per the point's mapping. */
export function encodePoint(
  p: Point,
  v: EncodableValue,
  ctx?: CodecContext,
): Uint16Array {
  const st = p.storageType;
  const m = p.mapping;
  const byteBig = m?.byteOrder !== ByteOrder.LITTLE_ENDIAN;
  const wordBig = m?.wordOrder !== WordOrder.WORD_LITTLE_ENDIAN;

  switch (st) {
    case StorageType.COMPOSED:
      throw new EncodeError(p.pointId, "composed values are not writable");
    case StorageType.STRING_ASCII:
    case StorageType.STRING_UTF8: {
      if (typeof v !== "string") {
        throw new EncodeError(p.pointId, `string expects string, got ${typeof v}`);
      }
      const b = new TextEncoder().encode(v);
      return bytesToWords(padBytes(b, words(p, st) * 2), byteBig, wordBig);
    }
    case StorageType.BYTES_RAW: {
      if (!(v instanceof Uint8Array)) {
        throw new EncodeError(p.pointId, `BYTES_RAW expects Uint8Array, got ${typeof v}`);
      }
      return bytesToWords(padBytes(v, words(p, st) * 2), byteBig, wordBig);
    }
    case StorageType.IEEE754_F32: {
      const buf = new DataView(new ArrayBuffer(4));
      buf.setFloat32(0, toFloat(v), false);
      return uintToWords(BigInt(buf.getUint32(0, false)), 2, byteBig, wordBig);
    }
    case StorageType.IEEE754_F64: {
      const buf = new DataView(new ArrayBuffer(8));
      buf.setFloat64(0, toFloat(v), false);
      return uintToWords(buf.getBigUint64(0, false), 4, byteBig, wordBig);
    }
  }

  const flags = p.valueType?.kind.case === "flags" ? p.valueType.kind.value : undefined;
  if (flags) {
    if (!Array.isArray(v)) {
      throw new EncodeError(p.pointId, `FLAGS expects string[], got ${typeof v}`);
    }
    return uintToWords(encodeFlags(v as string[], flags), words(p, st), byteBig, wordBig);
  }

  const bits = storageBits(st, words(p, st));
  let raw: bigint;
  const prim =
    p.valueType?.kind.case === "primitive" ? p.valueType.kind.value : PrimitiveType.PRIMITIVE_TYPE_UNSPECIFIED;

  switch (prim) {
    case PrimitiveType.BOOL:
      raw = v === true ? 1n : 0n;
      break;
    case PrimitiveType.DATETIME:
      raw = encodeDateTime(p, v);
      break;
    case PrimitiveType.DECIMAL:
    case PrimitiveType.FLOAT32:
    case PrimitiveType.FLOAT64:
      raw = BigInt.asUintN(64, encodeScaled(p, v, ctx)) & maskFor(bits);
      break;
    default:
      raw = BigInt.asUintN(64, toInt(p, v)) & maskFor(bits);
  }

  if (st === StorageType.BCD) raw = intToBCD(BigInt.asIntN(64, raw));
  return uintToWords(raw, words(p, st), byteBig, wordBig);
}

/** Inverse transform pipeline: raw = (value - offset) / scale. */
function encodeScaled(p: Point, v: EncodableValue, ctx?: CodecContext): bigint {
  let val = toRat(p, v);
  const t = p.transform;
  if (t) {
    if (t.offset && t.offset.denominator !== 0n) {
      val = R.sub(val, R.rat(t.offset.numerator, t.offset.denominator));
    }
    if (t.scaleRef) {
      const sf = ctx?.refs.get(t.scaleRef.pointId);
      if (sf === undefined) {
        throw new EncodeError(p.pointId, `scale_ref "${t.scaleRef.pointId}" not resolved`);
      }
      if (t.scaleRef.mode === ScaleMode.MULTIPLY) {
        const den = t.scaleRef.denominator === 0n ? 1n : t.scaleRef.denominator;
        val = R.div(val, R.rat(sf, den));
      } else {
        val = R.div(val, R.pow10(sf));
      }
    } else if (t.scale && t.scale.denominator !== 0n) {
      val = R.div(val, R.rat(t.scale.numerator, t.scale.denominator));
    }
  }
  return R.roundToBigint(val);
}

function encodeFlags(names: readonly string[], fl: FlagSet): bigint {
  const rev = new Map<string, number>();
  for (const [bit, name] of Object.entries(fl.bits)) rev.set(name, parseInt(bit, 10));
  let raw = 0n;
  for (const n of names) {
    const bit = rev.get(n);
    if (bit !== undefined) raw |= 1n << BigInt(bit);
  }
  return raw;
}

function encodeDateTime(p: Point, v: EncodableValue): bigint {
  if (!(v instanceof Date)) return 0n;
  if (p.datetime?.encoding === DateTimeEncoding.EPOCH_MS) return BigInt(v.getTime());
  return BigInt(Math.floor(v.getTime() / 1000));
}

// --- helpers -------------------------------------------------------------- //

/** Register count to write for p (mapping length or storage width). */
export function words(p: Point, st: StorageType): number {
  const n = p.mapping?.lengthWords ?? 0;
  if (n > 0) return n;
  return Math.max(1, Math.ceil(storageBits(st, 1) / 16));
}

function intToBCD(v: bigint): bigint {
  let raw = 0n;
  let shift = 0n;
  let x = v;
  while (x > 0n) {
    raw |= (x % 10n) << shift;
    shift += 4n;
    x /= 10n;
  }
  return raw;
}

function toFloat(v: EncodableValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return 0;
}

function toRat(p: Point, v: EncodableValue): R.Rat {
  if (typeof v === "number" || typeof v === "bigint") return R.fromValue(v);
  throw new EncodeError(p.pointId, `cannot convert ${typeof v} to number`);
}

function toInt(p: Point, v: EncodableValue): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.round(v));
  if (typeof v === "boolean") return v ? 1n : 0n;
  throw new EncodeError(p.pointId, `cannot convert ${typeof v} to integer`);
}
