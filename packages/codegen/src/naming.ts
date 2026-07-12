// SPDX-License-Identifier: Apache-2.0

/** Identifier mangling shared by all emitters. Deterministic; collisions get
 * numeric suffixes via a per-scope seen-set (same policy as the Python/Go
 * generators in moddef/go/gen). */

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "device", "constructor",
]);

function sanitize(id: string): string {
  let s = id.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "_" + s;
  return s;
}

export function camel(id: string): string {
  const parts = sanitize(id).split("_").filter(Boolean);
  const head = parts[0]?.toLowerCase() ?? "_";
  const rest = parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  let out = [head, ...rest].join("");
  if (RESERVED.has(out)) out += "_";
  return out;
}

export function pascal(id: string): string {
  const parts = sanitize(id).split("_").filter(Boolean);
  let out = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("");
  if (!out) out = "_";
  return out;
}

/** Enum member names stay SCREAMING_SNAKE, sanitized. */
export function member(name: string): string {
  let s = sanitize(name).toUpperCase();
  if (!s) s = "_";
  return s;
}

/** Allocate a unique name within a scope by suffixing duplicates. */
export class Scope {
  private seen = new Set<string>();

  claim(name: string): string {
    let out = name;
    let i = 2;
    while (this.seen.has(out)) out = `${name}${i++}`;
    this.seen.add(out);
    return out;
  }
}

/** Quote a string for embedding in generated source. */
export function q(s: string): string {
  return JSON.stringify(s);
}
