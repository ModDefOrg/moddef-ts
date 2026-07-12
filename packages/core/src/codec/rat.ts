// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal exact rational arithmetic over bigint, used to apply spec §10
 * transforms without float rounding until the final conversion to number.
 */

export interface Rat {
  n: bigint; // numerator
  d: bigint; // denominator > 0
}

export function rat(n: bigint | number, d: bigint | number = 1n): Rat {
  let nn = typeof n === "number" ? BigInt(Math.trunc(n)) : n;
  let dd = typeof d === "number" ? BigInt(Math.trunc(d)) : d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  return { n: nn, d: dd };
}

export function mul(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}

export function div(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d, a.d * b.n);
}

export function add(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function pow10(exp: bigint): Rat {
  const abs = exp < 0n ? -exp : exp;
  const p = 10n ** abs;
  return exp >= 0n ? rat(p, 1n) : rat(1n, p);
}

/** Round to nearest integer, half away from zero (matches Go ratRound). */
export function roundToBigint(r: Rat): bigint {
  const half = r.d / 2n;
  const n = r.n >= 0n ? r.n + half : r.n - half;
  return n / r.d;
}

/** Convert to float64. Exact division of bigints avoids overflow for large n/d. */
export function toNumber(r: Rat): number {
  const q = r.n / r.d;
  const rem = r.n % r.d;
  return Number(q) + Number(rem) / Number(r.d);
}

/** Parse a JS numeric value (number | bigint) into a Rat. */
export function fromValue(v: number | bigint): Rat {
  if (typeof v === "bigint") return rat(v);
  if (Number.isInteger(v)) return rat(BigInt(v));
  // Decimal-string route keeps common engineering values (e.g. 230.1) exact.
  const s = v.toString();
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return rat(BigInt(Math.round(v)));
  const sign = m[1] === "-" ? -1n : 1n;
  const int = m[2]!;
  const frac = m[3] ?? "";
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  let n = sign * BigInt(int + frac);
  let d = 10n ** BigInt(frac.length);
  if (exp > 0) n *= 10n ** BigInt(exp);
  else if (exp < 0) d *= 10n ** BigInt(-exp);
  return rat(n, d);
}
