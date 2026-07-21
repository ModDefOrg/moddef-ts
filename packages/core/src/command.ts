// SPDX-License-Identifier: Apache-2.0

/**
 * Command (multi-step register procedure) helpers, spec §11.7. The executor
 * itself is `Device.runCommand` in device.ts; this module holds the pure
 * pieces: poll-condition evaluation, single-PDU chunking caps, and the
 * synthetic points that let command params and raw trigger/poll values reuse
 * the shared codec.
 */

import { create } from "@bufbuild/protobuf";
import {
  ConditionOp,
  PointSchema,
  type CommandParam,
  type Condition,
  type Point,
} from "./schema/index.js";
import { decodePointRaw, isSigned } from "./codec/decode.js";

/** Modbus single-PDU practical caps (FC03/FC16); larger transfers chunk. */
export const MAX_READ_WORDS = 125;
export const MAX_WRITE_WORDS = 123;

/** Default poll interval when a PollStep omits interval_ms. */
export const DEFAULT_POLL_INTERVAL_MS = 250;

/** Evaluate a §11.7 poll exit condition against a raw integer. */
export function conditionMet(c: Condition | undefined, raw: bigint): boolean {
  switch (c?.op) {
    case ConditionOp.EQ:
      return raw === c.value;
    case ConditionOp.NE:
      return raw !== c.value;
    case ConditionOp.MASK:
      return (raw & c.mask) === c.value;
    case ConditionOp.RANGE:
      return raw >= c.min && raw <= c.max;
    default:
      return false;
  }
}

/** Synthetic point carrying a CommandParam's wire mapping for the codec. */
export function paramPoint(cp: CommandParam): Point {
  return create(PointSchema, {
    pointId: `param:${cp.field}`,
    storageType: cp.storageType,
    valueType: cp.valueType,
    mapping: cp.mapping,
  });
}

/**
 * Storage/mapping-only copy of a point: trigger writes and poll reads are
 * raw register values (§11.7), bypassing transform and value_type.
 */
export function rawPoint(p: Point): Point {
  return create(PointSchema, {
    pointId: p.pointId,
    storageType: p.storageType,
    mapping: p.mapping,
  });
}

/** Decode a point's raw (pre-transform) integer, sign-extended per storage. */
export function rawInt(p: Point, regs: ArrayLike<number>): bigint {
  const { raw, bits } = decodePointRaw(p, regs);
  return isSigned(p.storageType) ? BigInt.asIntN(bits, raw) : raw;
}
