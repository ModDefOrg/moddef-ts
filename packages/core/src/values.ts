/**
 * Decoded value model (spec §8, §13). Mirrors the Go codec's result kinds:
 * bool, int64/uint64, float64, *big.Rat, string, []byte, []string (flags),
 * time.Time, map (bit/register fields), and Unavailable.
 *
 * Numeric policy: scaled/decimal values are `number` (float64). 64-bit
 * integer primitives (UINT64/INT64) are `bigint`. Callers that need exact
 * pre-scale integers use `decodePointRaw`.
 */

/** A sentinel (na_values) hit: the device reports "no data" (spec §8.4). */
export class Unavailable {
  constructor(readonly meaning: string = "") {}
}

/** Decoded bit/register-field window: field_id -> numeric sub-value (§13). */
export type FieldValues = { readonly [fieldId: string]: number };

export type DecodedValue =
  | number
  | bigint
  | boolean
  | string
  | readonly string[]
  | Uint8Array
  | Date
  | FieldValues
  | Unavailable;

export function isUnavailable(v: DecodedValue): v is Unavailable {
  return v instanceof Unavailable;
}
