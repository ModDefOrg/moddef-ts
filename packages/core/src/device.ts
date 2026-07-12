// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime device facade (spec §32.4): binds a Transport to one device profile
 * for point- and measurand-based reads/writes. Port of go/client/client.go
 * with one deviation, documented:
 *
 *  - Writes are implemented (writePoint with §11.4 constraint validation);
 *    the Go facade is read-only so far.
 *
 * SunSpec model_relative_offset is resolved against the model *ID register*
 * (offset 0 = model id, 1 = length, data at 2+) per spec §7.3 — the same
 * convention as the Go client and the profiles in devices/.
 *
 * Shared limitation kept in lockstep with Go: composed (multi-register
 * mantissa/exponent) points decode via the codec directly, not through the
 * facade.
 */

import {
  AccessMode,
  AddressSpace,
  DiscoveryKind,
  StorageType,
  type DeviceProfile,
  type ModDefDocument,
  type Point,
  type RegisterBlock,
} from "./schema/index.js";
import type { Transport, TransportOpts } from "./transport.js";
import {
  AmbiguousMeasurandError,
  MeasurandNotSupportedError,
  PointNotFoundError,
  UnsupportedMappingError,
  WriteAccessError,
  WriteConstraintError,
} from "./errors.js";
import { decodePoint, emptyContext, type CodecContext } from "./codec/decode.js";
import { encodePoint, words, type EncodableValue } from "./codec/encode.js";
import { asInt } from "./codec/context.js";
import { measurandMatches, type MeasurandQuery } from "./measurand.js";
import type { DecodedValue } from "./values.js";

/** "SunS" marker as two big-endian 16-bit words. */
const SUNS_MARKER: readonly [number, number] = [0x5375, 0x6e53];

export interface PointInfo {
  readonly point: Point;
  readonly block: RegisterBlock;
}

export class Device {
  private readonly pts = new Map<string, PointInfo>();
  private readonly order: Point[] = [];
  private readonly modelBase = new Map<string, number>();

  private constructor(
    readonly profile: DeviceProfile,
    private readonly t: Transport,
  ) {
    for (const b of profile.blocks) {
      for (const p of b.points) {
        this.pts.set(p.pointId, { point: p, block: b });
        this.order.push(p);
      }
    }
  }

  /** Bind a transport to the named device profile in doc (or the only one). */
  static create(doc: ModDefDocument, deviceId: string | undefined, t: Transport): Device {
    const prof = doc.devices.find((d) => !deviceId || d.deviceId === deviceId);
    if (!prof) throw new PointNotFoundError(`device profile ${deviceId ?? "(any)"}`);
    return new Device(prof, t);
  }

  /** Metadata access (spec §32.1). */
  points(): readonly PointInfo[] {
    return [...this.pts.values()];
  }

  point(id: string): PointInfo {
    const pi = this.pts.get(id);
    if (!pi) throw new PointNotFoundError(id);
    return pi;
  }

  /** Read and decode a single point by id. */
  async readPoint(id: string, opts?: TransportOpts): Promise<DecodedValue> {
    const { point } = this.point(id);
    const regs = await this.readRegisters(point, opts);
    const ctx = await this.refContext(point, opts);
    return decodePoint(point, regs, ctx);
  }

  /** Read several points; refs are resolved once per call. */
  async readPoints(ids: readonly string[], opts?: TransportOpts): Promise<Map<string, DecodedValue>> {
    const out = new Map<string, DecodedValue>();
    for (const id of ids) out.set(id, await this.readPoint(id, opts));
    return out;
  }

  /** Read a point by its semantic measurand tuple (spec §26.1). */
  async readMeasurand(q: MeasurandQuery, opts?: TransportOpts): Promise<DecodedValue> {
    const matches = this.order.filter((p) => measurandMatches(p.measurand, q));
    if (matches.length === 0) throw new MeasurandNotSupportedError(q);
    if (matches.length > 1) {
      throw new AmbiguousMeasurandError(q, matches.map((p) => p.pointId));
    }
    return this.readPoint(matches[0]!.pointId, opts);
  }

  /** Encode and write a value, validating access mode and §11.4 constraints. */
  async writePoint(id: string, value: EncodableValue, opts?: TransportOpts): Promise<void> {
    const { point, block } = this.point(id);
    if (
      point.access !== AccessMode.READ_WRITE &&
      point.access !== AccessMode.WRITE_ONLY &&
      point.access !== AccessMode.COMMAND
    ) {
      throw new WriteAccessError(id, AccessMode[point.access] ?? String(point.access));
    }
    validateConstraints(point, value);

    const space = this.spaceOf(point, block);
    const off = await this.offsetOf(point, block, opts);

    if (space === AddressSpace.COIL) {
      await this.t.writeCoil(off, value === true || value === 1, opts);
      return;
    }
    if (space !== AddressSpace.HOLDING_REGISTER) {
      throw new UnsupportedMappingError(id, `cannot write address space ${AddressSpace[space]}`);
    }
    const ctx = await this.refContext(point, opts);
    const regs = encodePoint(point, value, ctx);
    await this.t.writeHolding(off, regs, opts);
  }

  // --- internals ----------------------------------------------------------- //

  /** Read the points referenced by p's scale_ref/selector_ref (spec §10.4/§10.5). */
  private async refContext(p: Point, opts?: TransportOpts): Promise<CodecContext> {
    const ctx = emptyContext();
    const add = async (id: string): Promise<void> => {
      const pi = this.pts.get(id);
      if (!pi) throw new PointNotFoundError(id);
      const regs = await this.readRegisters(pi.point, opts);
      const v = decodePoint(pi.point, regs);
      const iv = asInt(v);
      if (iv !== undefined) ctx.refs.set(id, iv);
    };
    const sr = p.transform?.scaleRef;
    if (sr) await add(sr.pointId);
    if (p.selectorRef) await add(p.selectorRef.pointId);
    return ctx;
  }

  private spaceOf(p: Point, blk: RegisterBlock): AddressSpace {
    const s = p.mapping?.space ?? AddressSpace.ADDRESS_SPACE_UNSPECIFIED;
    return s === AddressSpace.ADDRESS_SPACE_UNSPECIFIED ? blk.space : s;
  }

  private async offsetOf(p: Point, blk: RegisterBlock, opts?: TransportOpts): Promise<number> {
    const m = p.mapping;
    if (!m) throw new UnsupportedMappingError(p.pointId, "point has no mapping");
    if (blk.discovery) {
      const base = await this.resolveModelBase(blk, opts);
      return base + m.modelRelativeOffset;
    }
    return m.offset;
  }

  private async readRegisters(p: Point, opts?: TransportOpts): Promise<Uint16Array> {
    if (p.storageType === StorageType.COMPOSED) {
      throw new UnsupportedMappingError(p.pointId, "composed points are not read via the facade");
    }
    const { block } = this.point(p.pointId);
    const space = this.spaceOf(p, block);
    const n = pointWords(p);
    const off = await this.offsetOf(p, block, opts);
    return this.readSpace(space, off, n, opts);
  }

  private async readSpace(
    space: AddressSpace,
    off: number,
    n: number,
    opts?: TransportOpts,
  ): Promise<Uint16Array> {
    switch (space) {
      case AddressSpace.HOLDING_REGISTER:
        return this.t.readHolding(off, n, opts);
      case AddressSpace.INPUT_REGISTER:
        return this.t.readInput(off, n, opts);
      case AddressSpace.COIL: {
        const bits = await this.t.readCoils(off, 1, opts);
        return Uint16Array.of(bits[0] ? 1 : 0);
      }
      case AddressSpace.DISCRETE_INPUT: {
        const bits = await this.t.readDiscrete(off, 1, opts);
        return Uint16Array.of(bits[0] ? 1 : 0);
      }
      default:
        throw new UnsupportedMappingError("(block)", "unspecified address space");
    }
  }

  /**
   * Probe discovery anchors for the SunS marker, walk the (model_id, length)
   * chain, and return the register offset of the target model's ID register.
   * Cached per block (spec §7.3).
   */
  private async resolveModelBase(blk: RegisterBlock, opts?: TransportOpts): Promise<number> {
    const cached = this.modelBase.get(blk.blockId);
    if (cached !== undefined) return cached;
    const disc = blk.discovery!;
    if (disc.kind !== DiscoveryKind.SUNSPEC) {
      throw new UnsupportedMappingError(blk.blockId, "unsupported discovery kind");
    }
    const space = blk.space;
    const candidates = disc.anchorCandidates.length > 0 ? disc.anchorCandidates : [40000, 50000, 0];

    let anchor: number | undefined;
    for (const c of candidates) {
      try {
        const hdr = await this.readSpace(space, c, 2, opts);
        if (hdr[0] === SUNS_MARKER[0] && hdr[1] === SUNS_MARKER[1]) {
          anchor = c;
          break;
        }
      } catch {
        // Try the next candidate; devices answer exceptions off-anchor.
      }
    }
    if (anchor === undefined) {
      throw new UnsupportedMappingError(blk.blockId, `SunS marker not found at [${candidates.join(", ")}]`);
    }

    // Walk model headers starting just after the marker.
    let off = anchor + 2;
    for (let i = 0; i < 256; i++) {
      const hdr = await this.readSpace(space, off, 2, opts);
      const id = hdr[0]!;
      const length = hdr[1]!;
      if (id === 0xffff) break;
      if (id === disc.modelId) {
        // Base is the model ID register: model_relative_offset 0 = ID (§7.3).
        this.modelBase.set(blk.blockId, off);
        return off;
      }
      off += 2 + length;
    }
    throw new UnsupportedMappingError(blk.blockId, `SunSpec model ${disc.modelId} not found`);
  }
}

/** Register count to read for p (mapping length or storage width). */
export function pointWords(p: Point): number {
  return words(p, p.storageType);
}

/** Validate a write value against WriteConstraints (spec §11.4). */
export function validateConstraints(p: Point, value: EncodableValue): void {
  const c = p.write?.constraints;
  if (!c) return;
  const num =
    typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;

  if (c.allowedValues.length > 0) {
    const iv = num !== undefined ? BigInt(Math.round(num)) : undefined;
    if (iv === undefined || !c.allowedValues.some((a) => a === iv)) {
      throw new WriteConstraintError(
        p.pointId,
        "allowed_values",
        value,
        `value ${String(value)} not in allowed_values [${c.allowedValues.join(", ")}]`,
      );
    }
    return;
  }
  if (num === undefined) return;
  if (c.minValue && c.minValue.denominator !== 0n) {
    const min = Number(c.minValue.numerator) / Number(c.minValue.denominator);
    if (num < min) {
      throw new WriteConstraintError(p.pointId, "min_value", value, `value ${num} below minimum ${min}`);
    }
  }
  if (c.maxValue && c.maxValue.denominator !== 0n) {
    const max = Number(c.maxValue.numerator) / Number(c.maxValue.denominator);
    if (num > max) {
      throw new WriteConstraintError(p.pointId, "max_value", value, `value ${num} above maximum ${max}`);
    }
  }
  if (c.step && c.step.denominator !== 0n && c.step.numerator !== 0n) {
    const step = Number(c.step.numerator) / Number(c.step.denominator);
    const base = c.minValue && c.minValue.denominator !== 0n
      ? Number(c.minValue.numerator) / Number(c.minValue.denominator)
      : 0;
    const k = (num - base) / step;
    if (Math.abs(k - Math.round(k)) > 1e-9) {
      throw new WriteConstraintError(p.pointId, "step", value, `value ${num} is not a multiple of step ${step}`);
    }
  }
}
