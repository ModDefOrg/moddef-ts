/**
 * Node-only conveniences: filesystem document loading and a package resolver
 * over MODDEF_PACKAGE_ROOTS-style directories. Import from "@moddef/core/node".
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModDefDocument } from "./schema/index.js";
import { detectFormat, parseDocument } from "./document.js";
import { ParseError } from "./errors.js";
import type { PackageResolver, PackageSource } from "./resolve.js";

/** Load and parse a .moddef.yaml / .moddef.json / .moddef file. */
export async function loadDocument(path: string): Promise<ModDefDocument> {
  const format = detectFormat(path);
  const data = await readFile(path);
  return parseDocument(format === "binary" ? new Uint8Array(data) : data.toString("utf8"), format);
}

/**
 * Resolver that maps `moddef:<ns>:<name>:<version>` to
 * `<root>/<name>/<version>/<name>.moddef.{yaml,json,binary-ext}` under the
 * given roots (the layout of moddef/stdlib; same as the Go resolver).
 */
export function dirResolver(roots: readonly string[]): PackageResolver {
  return {
    async fetch(uri: string): Promise<PackageSource> {
      const parts = uri.split(":");
      if (parts.length !== 4 || parts[0] !== "moddef") {
        throw new ParseError(`unsupported import uri: ${uri}`);
      }
      const [, , name, version] = parts;
      const candidates = [
        { file: `${name}.moddef.yaml`, format: "yaml" as const },
        { file: `${name}.moddef.json`, format: "json" as const },
        { file: `${name}.moddef`, format: "binary" as const },
      ];
      for (const root of roots) {
        for (const c of candidates) {
          try {
            const data = await readFile(join(root, name!, version!, c.file));
            return {
              data: c.format === "binary" ? new Uint8Array(data) : data.toString("utf8"),
              format: c.format,
            };
          } catch {
            // try next candidate
          }
        }
      }
      throw new ParseError(`import not found under package roots: ${uri}`);
    },
  };
}

/** Resolver from the MODDEF_PACKAGE_ROOTS environment variable. */
export function envResolver(env: NodeJS.ProcessEnv = process.env): PackageResolver {
  const roots = (env.MODDEF_PACKAGE_ROOTS ?? "").split(":").filter(Boolean);
  return dirResolver(roots);
}
