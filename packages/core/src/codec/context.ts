// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-point reference resolution (port of go/codec/device.go): the set of
 * points referenced by scale_ref / selector_ref, and a Context built from
 * their decoded integer values.
 */

import type { DeviceProfile, Point } from "../schema/index.js";
import { decodePoint, emptyContext, type CodecContext } from "./decode.js";
import type { DecodedValue } from "../values.js";

export function allPoints(dev: DeviceProfile): Point[] {
  const pts: Point[] = [];
  for (const b of dev.blocks) pts.push(...b.points);
  return pts;
}

/** Point ids referenced by any point's scale_ref or selector_ref. */
export function referencedPoints(points: readonly Point[]): Set<string> {
  const refs = new Set<string>();
  for (const p of points) {
    const sr = p.transform?.scaleRef;
    if (sr) refs.add(sr.pointId);
    if (p.selectorRef) refs.add(p.selectorRef.pointId);
  }
  return refs;
}

/**
 * Decode the points that other points reference and return a CodecContext
 * with their integer values. regsByPoint maps point_id -> raw registers.
 */
export function resolveContext(
  points: readonly Point[],
  regsByPoint: ReadonlyMap<string, ArrayLike<number>>,
): CodecContext {
  const needed = referencedPoints(points);
  const ctx = emptyContext();
  for (const p of points) {
    if (!needed.has(p.pointId)) continue;
    const regs = regsByPoint.get(p.pointId);
    if (!regs) continue;
    try {
      const v = decodePoint(p, regs);
      const iv = asInt(v);
      if (iv !== undefined) ctx.refs.set(p.pointId, iv);
    } catch {
      // Unresolvable refs simply stay absent; dependent decodes will error.
    }
  }
  return ctx;
}

/**
 * Resolve cross-point references then decode every supplied point whose
 * registers are present, returning point_id -> typed value.
 */
export function decodeAll(
  points: readonly Point[],
  regsByPoint: ReadonlyMap<string, ArrayLike<number>>,
): Map<string, DecodedValue> {
  const ctx = resolveContext(points, regsByPoint);
  const out = new Map<string, DecodedValue>();
  for (const p of points) {
    const regs = regsByPoint.get(p.pointId);
    if (!regs) continue;
    out.set(p.pointId, decodePoint(p, regs, ctx));
  }
  return out;
}

export function asInt(v: DecodedValue): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "boolean") return v ? 1n : 0n;
  return undefined;
}
