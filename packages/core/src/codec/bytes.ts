/**
 * Register/byte assembly honoring byte order within a word and word order
 * across words (spec §9). Port of go/codec assemble/uintToWords/bytesToWords.
 */

/** Normalize register words into a big-endian byte array. */
export function assemble(regs: ArrayLike<number>, byteBig: boolean, wordBig: boolean): Uint8Array {
  const n = regs.length;
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const w = regs[wordBig ? i : n - 1 - i]! & 0xffff;
    const hi = (w >> 8) & 0xff;
    const lo = w & 0xff;
    out[2 * i] = byteBig ? hi : lo;
    out[2 * i + 1] = byteBig ? lo : hi;
  }
  return out;
}

/** Big-endian bytes -> unsigned bigint. */
export function decodeUint(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** Last n bytes of b (identity when b is shorter). */
export function lastN(b: Uint8Array, n: number): Uint8Array {
  return b.length <= n ? b : b.subarray(b.length - n);
}

export function signExtend(v: bigint, bits: number): bigint {
  if (bits >= 64) return BigInt.asIntN(64, v);
  const signBit = 1n << BigInt(bits - 1);
  if (v & signBit) return v - (1n << BigInt(bits));
  return v;
}

export function maskFor(bits: number): bigint {
  if (bits >= 64) return (1n << 64n) - 1n;
  return (1n << BigInt(bits)) - 1n;
}

/** Pack a big-endian byte array (len 2*n) into registers (inverse of assemble). */
export function bytesToWords(b: Uint8Array, byteBig: boolean, wordBig: boolean): Uint16Array {
  const n = b.length >> 1;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let hi = b[2 * i]!;
    let lo = b[2 * i + 1]!;
    if (!byteBig) [hi, lo] = [lo, hi];
    out[i] = ((hi << 8) | lo) & 0xffff;
  }
  if (!wordBig) out.reverse();
  return out;
}

/** Split a raw unsigned integer into nwords registers. */
export function uintToWords(raw: bigint, nwords: number, byteBig: boolean, wordBig: boolean): Uint16Array {
  const b = new Uint8Array(nwords * 2);
  let v = raw;
  for (let i = nwords * 2 - 1; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytesToWords(b, byteBig, wordBig);
}

export function padBytes(b: Uint8Array, n: number): Uint8Array {
  if (b.length >= n) return b.subarray(0, n);
  const out = new Uint8Array(n);
  out.set(b);
  return out;
}
