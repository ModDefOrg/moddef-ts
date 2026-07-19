// SPDX-License-Identifier: Apache-2.0

/**
 * Codec unit vectors mirroring go/codec/decode_test.go and roundtrip_test.go:
 * integer widths, endianness, scaling, refs, strings, BCD, flags, fields,
 * datetime, sentinels, composed values, and encode round-trips.
 */
import { describe, expect, it } from "vitest";
import {
  Unavailable,
  decodePoint,
  encodePoint,
  emptyContext,
  resolveContext,
  decodeAll,
} from "@moddef/core";
import { point } from "./helpers.js";

describe("integer decoding", () => {
  it("U16 with 0.1 scale", () => {
    const p = point({
      pointId: "v",
      storageType: "U16",
      valueType: { primitive: "DECIMAL" },
      mapping: { space: "HOLDING_REGISTER", offset: 0, lengthWords: 1 },
      transform: { scale: { numerator: "1", denominator: "10" } },
    });
    expect(decodePoint(p, [2305])).toBeCloseTo(230.5, 10);
  });

  it("S16 negative two's complement", () => {
    const p = point({
      pointId: "t",
      storageType: "S16",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 1 },
      transform: { scale: { numerator: "1", denominator: "10" } },
    });
    expect(decodePoint(p, [0xfff6])).toBeCloseTo(-1.0, 10);
  });

  it("U32 word orders", () => {
    const big = point({
      pointId: "e",
      storageType: "U32",
      valueType: { primitive: "UINT32" },
      mapping: { lengthWords: 2, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_BIG_ENDIAN" },
    });
    expect(decodePoint(big, [0x0001, 0x86a0])).toBe(100000);

    const little = point({
      pointId: "e2",
      storageType: "U32",
      valueType: { primitive: "UINT32" },
      mapping: { lengthWords: 2, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_LITTLE_ENDIAN" },
    });
    expect(decodePoint(little, [0x86a0, 0x0001])).toBe(100000);
  });

  it("U64 primitive returns bigint", () => {
    const p = point({
      pointId: "acc",
      storageType: "U64",
      valueType: { primitive: "UINT64" },
      mapping: { lengthWords: 4, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_BIG_ENDIAN" },
    });
    expect(decodePoint(p, [0x0000, 0x0001, 0x0000, 0x0000])).toBe(4294967296n);
  });

  it("S48 sign extension", () => {
    const p = point({
      pointId: "n",
      storageType: "S48",
      valueType: { primitive: "INT64" },
      mapping: { lengthWords: 3, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_BIG_ENDIAN" },
    });
    expect(decodePoint(p, [0xffff, 0xffff, 0xfffe])).toBe(-2n);
  });

  it("enum-backed point returns raw number", () => {
    const p = point({
      pointId: "mode",
      storageType: "U16",
      valueType: { enumRef: { typeId: "work_mode" } },
      mapping: { lengthWords: 1 },
    });
    expect(decodePoint(p, [5])).toBe(5);
  });
});

describe("floats", () => {
  it("IEEE754 F32 big endian", () => {
    // 230.5f = 0x43668000
    const p = point({
      pointId: "v",
      storageType: "IEEE754_F32",
      valueType: { primitive: "FLOAT32" },
      mapping: { lengthWords: 2, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_BIG_ENDIAN" },
    });
    expect(decodePoint(p, [0x4366, 0x8000])).toBeCloseTo(230.5, 5);
  });
});

describe("sentinels (na_values)", () => {
  it("uint16 0xFFFF -> Unavailable", () => {
    const p = point({
      pointId: "a",
      storageType: "U16",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 1 },
      naValues: [{ raw: "65535", meaning: "not_implemented" }],
    });
    const v = decodePoint(p, [0xffff]);
    expect(v).toBeInstanceOf(Unavailable);
    expect((v as Unavailable).meaning).toBe("not_implemented");
  });

  it("sint16 0x8000 sentinel matches on masked raw", () => {
    const p = point({
      pointId: "a",
      storageType: "S16",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 1 },
      naValues: [{ raw: "32768" }],
    });
    expect(decodePoint(p, [0x8000])).toBeInstanceOf(Unavailable);
    expect(decodePoint(p, [0x7fff])).not.toBeInstanceOf(Unavailable);
  });
});

describe("strings, BCD, flags, fields", () => {
  it("fixed-length space-padded ASCII", () => {
    const p = point({
      pointId: "sn",
      storageType: "STRING_ASCII",
      valueType: { primitive: "STRING" },
      mapping: {
        lengthWords: 3,
        byteOrder: "BIG_ENDIAN",
        wordOrder: "WORD_BIG_ENDIAN",
        stringEncoding: { charset: "ASCII", padding: "PADDING_SPACE", termination: "FIXED_LENGTH" },
      },
    });
    // "AB12  "
    expect(decodePoint(p, [0x4142, 0x3132, 0x2020])).toBe("AB12");
  });

  it("BCD digits", () => {
    const p = point({
      pointId: "b",
      storageType: "BCD",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 1 },
    });
    expect(decodePoint(p, [0x1234])).toBe(1234);
  });

  it("flag set names of set bits", () => {
    const p = point({
      pointId: "alarms",
      storageType: "U16",
      valueType: { flags: { bits: { "0": "over_voltage", "2": "over_temp", "7": "door_open" } } },
      mapping: { lengthWords: 1 },
    });
    expect(decodePoint(p, [0b10000101])).toEqual(["over_voltage", "over_temp", "door_open"]);
    expect(decodePoint(p, [0])).toEqual([]);
  });

  it("register fields: packed hour/minute", () => {
    const p = point({
      pointId: "slot",
      storageType: "U16",
      valueType: { primitive: "UINT32" },
      fields: [
        { fieldId: "hour", bitOffset: 8, bitLength: 8 },
        { fieldId: "minute", bitOffset: 0, bitLength: 8 },
      ],
      mapping: { lengthWords: 1 },
    });
    expect(decodePoint(p, [(21 << 8) | 45])).toEqual({ hour: 21, minute: 45 });
  });
});

describe("datetime", () => {
  it("epoch seconds", () => {
    const p = point({
      pointId: "rtc",
      storageType: "U32",
      valueType: { primitive: "DATETIME" },
      datetime: { encoding: "EPOCH_S", width: "U32" },
      mapping: { lengthWords: 2, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_BIG_ENDIAN" },
    });
    const v = decodePoint(p, [0x6543, 0x2100]) as Date;
    expect(v.getTime()).toBe(0x65432100 * 1000);
  });
});

describe("scale_ref (SunSpec SF) and context", () => {
  const sf = point({
    pointId: "w_sf",
    storageType: "S16",
    valueType: { primitive: "INT32" },
    mapping: { lengthWords: 1 },
  });
  const w = point({
    pointId: "w",
    storageType: "S16",
    valueType: { primitive: "DECIMAL" },
    mapping: { lengthWords: 1 },
    transform: { scaleRef: { pointId: "w_sf", mode: "POW10" } },
  });

  it("POW10: value = raw * 10^sf", () => {
    const ctx = emptyContext();
    ctx.refs.set("w_sf", -1n);
    expect(decodePoint(w, [2301], ctx)).toBeCloseTo(230.1, 10);
    ctx.refs.set("w_sf", 2n);
    expect(decodePoint(w, [15], ctx)).toBe(1500);
  });

  it("missing ref throws", () => {
    expect(() => decodePoint(w, [2301], emptyContext())).toThrow(/scale_ref/);
  });

  it("resolveContext + decodeAll", () => {
    const regs = new Map<string, ArrayLike<number>>([
      ["w_sf", [0xffff]], // -1
      ["w", [2301]],
    ]);
    const out = decodeAll([sf, w], regs);
    expect(out.get("w")).toBeCloseTo(230.1, 10);
    const ctx = resolveContext([sf, w], regs);
    expect(ctx.refs.get("w_sf")).toBe(-1n);
  });
});

describe("composed values", () => {
  it("mantissa * base^exponent", () => {
    const p = point({
      pointId: "pwr",
      storageType: "COMPOSED",
      valueType: { primitive: "DECIMAL" },
      mapping: {
        lengthWords: 2,
        composed: {
          kind: "MANTISSA_EXPONENT",
          base: "10",
          mantissa: { offset: 0, lengthWords: 1 },
          exponent: { offset: 1, lengthWords: 1 },
        },
      },
    });
    expect(decodePoint(p, [1500, 0xffff])).toBeCloseTo(150.0, 10); // 1500 * 10^-1
  });

  it("embedded decade exponent (Iskra T6, same-word bit windows)", () => {
    // FD 01 E2 40: exponent 0xFD = -3 (bits 24-31), mantissa 0x01E240 =
    // 123456 (bits 0-23) -> 123.456.
    const p = point({
      pointId: "pwr",
      storageType: "COMPOSED",
      valueType: { primitive: "DECIMAL" },
      mapping: {
        lengthWords: 2,
        composed: {
          kind: "MANTISSA_EXPONENT",
          base: "10",
          mantissa: {
            offset: 0, lengthWords: 2, byteOrder: "BIG_ENDIAN",
            wordOrder: "WORD_BIG_ENDIAN", storageType: "S32",
            bitOffset: 0, bitLength: 24,
          },
          exponent: {
            offset: 0, lengthWords: 2, byteOrder: "BIG_ENDIAN",
            wordOrder: "WORD_BIG_ENDIAN", storageType: "S16",
            bitOffset: 24, bitLength: 8,
          },
        },
      },
    });
    expect(decodePoint(p, [0xfd01, 0xe240])).toBeCloseTo(123.456, 10);
    // Negative mantissa: -123456 = 0xFE1DC0 in 24-bit two's complement.
    expect(decodePoint(p, [0xfdfe, 0x1dc0])).toBeCloseTo(-123.456, 10);
  });

  it("embedded exponent with unsigned mantissa (Iskra T5) does not sign-extend", () => {
    const p = point({
      pointId: "v",
      storageType: "COMPOSED",
      valueType: { primitive: "DECIMAL" },
      mapping: {
        lengthWords: 2,
        composed: {
          kind: "MANTISSA_EXPONENT",
          base: "10",
          mantissa: {
            offset: 0, lengthWords: 2, byteOrder: "BIG_ENDIAN",
            wordOrder: "WORD_BIG_ENDIAN", storageType: "U32",
            bitOffset: 0, bitLength: 24,
          },
          exponent: {
            offset: 0, lengthWords: 2, byteOrder: "BIG_ENDIAN",
            wordOrder: "WORD_BIG_ENDIAN", storageType: "S16",
            bitOffset: 24, bitLength: 8,
          },
        },
      },
    });
    expect(decodePoint(p, [0x0080, 0x0000])).toBe(8388608); // mantissa bit 23 set
  });

  it("embedded 8-bit exponent + 56-bit mantissa (Eaton PXM GENERAL FORMAT)", () => {
    const p = point({
      pointId: "e",
      storageType: "COMPOSED",
      valueType: { primitive: "DECIMAL" },
      mapping: {
        lengthWords: 4,
        composed: {
          kind: "MANTISSA_EXPONENT",
          base: "10",
          mantissa: {
            offset: 0, lengthWords: 4, byteOrder: "BIG_ENDIAN",
            wordOrder: "WORD_BIG_ENDIAN", storageType: "U64",
            bitOffset: 0, bitLength: 56,
          },
          exponent: {
            offset: 0, lengthWords: 4, byteOrder: "BIG_ENDIAN",
            wordOrder: "WORD_BIG_ENDIAN", storageType: "S16",
            bitOffset: 56, bitLength: 8,
          },
        },
      },
    });
    // 123456789 * 10^-1 = 12345678.9
    expect(decodePoint(p, [0xff00, 0x0000, 0x075b, 0xcd15])).toBeCloseTo(12345678.9, 6);
  });
});

describe("encode round-trips", () => {
  it("scaled U16", () => {
    const p = point({
      pointId: "sp",
      storageType: "U16",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 1 },
      transform: { scale: { numerator: "1", denominator: "10" } },
    });
    const regs = encodePoint(p, 230.5);
    expect([...regs]).toEqual([2305]);
    expect(decodePoint(p, regs)).toBeCloseTo(230.5, 10);
  });

  it("negative offset transform round-trip", () => {
    // value = raw*0.1 - 1 (Growatt EPS power factor style)
    const p = point({
      pointId: "pf",
      storageType: "U16",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 1 },
      transform: {
        scale: { numerator: "1", denominator: "10" },
        offset: { numerator: "-1", denominator: "1" },
      },
    });
    expect(decodePoint(p, [15])).toBeCloseTo(0.5, 10);
    expect([...encodePoint(p, 0.5)]).toEqual([15]);
  });

  it("scale_ref encode divides by 10^sf", () => {
    const p = point({
      pointId: "w",
      storageType: "S16",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 1 },
      transform: { scaleRef: { pointId: "w_sf", mode: "POW10" } },
    });
    const ctx = emptyContext();
    ctx.refs.set("w_sf", -1n);
    expect([...encodePoint(p, 230.1, ctx)]).toEqual([2301]);
  });

  it("string, flags, bool, datetime, F32 round-trips", () => {
    const s = point({
      pointId: "s",
      storageType: "STRING_ASCII",
      valueType: { primitive: "STRING" },
      mapping: {
        lengthWords: 2,
        stringEncoding: { charset: "ASCII", padding: "PADDING_NULL", termination: "FIXED_LENGTH" },
      },
    });
    expect(decodePoint(s, encodePoint(s, "Hi!"))).toBe("Hi!");

    const fl = point({
      pointId: "f",
      storageType: "U16",
      valueType: { flags: { bits: { "1": "a", "3": "b" } } },
      mapping: { lengthWords: 1 },
    });
    expect(decodePoint(fl, encodePoint(fl, ["b"]))).toEqual(["b"]);

    const b = point({
      pointId: "b",
      storageType: "U16",
      valueType: { primitive: "BOOL" },
      mapping: { lengthWords: 1 },
    });
    expect(decodePoint(b, encodePoint(b, true))).toBe(true);

    const dt = point({
      pointId: "d",
      storageType: "U32",
      valueType: { primitive: "DATETIME" },
      datetime: { encoding: "EPOCH_S", width: "U32" },
      mapping: { lengthWords: 2, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_BIG_ENDIAN" },
    });
    const when = new Date(1700000000 * 1000);
    expect((decodePoint(dt, encodePoint(dt, when)) as Date).getTime()).toBe(when.getTime());

    const f32 = point({
      pointId: "f32",
      storageType: "IEEE754_F32",
      valueType: { primitive: "FLOAT32" },
      mapping: { lengthWords: 2, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_BIG_ENDIAN" },
    });
    expect(decodePoint(f32, encodePoint(f32, 230.5))).toBeCloseTo(230.5, 4);
  });

  it("S16 negative encode", () => {
    const p = point({
      pointId: "t",
      storageType: "S16",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 1 },
      transform: { scale: { numerator: "1", denominator: "10" } },
    });
    expect([...encodePoint(p, -1.0)]).toEqual([0xfff6]);
  });
});

describe("selector_ref cases (§10.5)", () => {
  it("applies the case scale selected by the ref value", () => {
    const p = point({
      pointId: "energy",
      storageType: "U32",
      valueType: { primitive: "DECIMAL" },
      mapping: { lengthWords: 2, byteOrder: "BIG_ENDIAN", wordOrder: "WORD_BIG_ENDIAN" },
      selectorRef: {
        pointId: "fmt",
        cases: {
          "0": { scale: { numerator: "1", denominator: "1000" }, unit: "kWh" },
          "1": { scale: { numerator: "1", denominator: "1" }, unit: "kWh" },
        },
      },
    });
    const ctx = emptyContext();
    ctx.refs.set("fmt", 0n);
    expect(decodePoint(p, [0, 5000], ctx)).toBeCloseTo(5, 10);
    ctx.refs.set("fmt", 1n);
    expect(decodePoint(p, [0, 5000], ctx)).toBe(5000);
  });
});
