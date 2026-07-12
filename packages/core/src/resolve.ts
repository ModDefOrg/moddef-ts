// SPDX-License-Identifier: Apache-2.0

/**
 * Import resolution (spec §19). Browser-safe: consumers supply a
 * PackageResolver; a filesystem resolver lives in `@moddef/core/node`.
 *
 * Import URIs follow the package form `moddef:<namespace>:<name>:<version>`
 * (e.g. `moddef:stdlib:measurands:1.0.0`), resolved against package roots as
 * `<root>/<name>/<version>/<name>.moddef.{yaml,json,binary}` — the same layout
 * as moddef/stdlib and the Go resolver's MODDEF_PACKAGE_ROOTS.
 */

import type { EnumType, MeasurandDefinition, ModDefDocument } from "./schema/index.js";
import { parseDocument, type DocumentFormat } from "./document.js";
import { ParseError } from "./errors.js";

export interface PackageSource {
  data: string | Uint8Array;
  format: DocumentFormat;
}

export interface PackageResolver {
  /** Fetch the document for an import uri, e.g. "moddef:stdlib:measurands:1.0.0". */
  fetch(uri: string): Promise<PackageSource>;
}

export interface ResolvedDocument {
  doc: ModDefDocument;
  /** enums visible to the document: local first, then imported. */
  enums: Map<string, EnumType>;
  /** measurand definitions visible to the document. */
  measurands: Map<string, MeasurandDefinition>;
  /** imported documents keyed by uri. */
  imports: Map<string, ModDefDocument>;
}

/** A resolver over a preloaded uri -> source map (browser-friendly). */
export function mapResolver(entries: ReadonlyMap<string, PackageSource>): PackageResolver {
  return {
    fetch: async (uri) => {
      const e = entries.get(uri);
      if (!e) throw new ParseError(`import not found: ${uri}`);
      return e;
    },
  };
}

/** Resolve a document's imports and build the visible symbol tables. */
export async function resolveImports(
  doc: ModDefDocument,
  resolver?: PackageResolver,
): Promise<ResolvedDocument> {
  const enums = new Map<string, EnumType>();
  const measurands = new Map<string, MeasurandDefinition>();
  const imports = new Map<string, ModDefDocument>();

  for (const e of doc.enums) enums.set(e.typeId, e);
  for (const m of doc.measurands) measurands.set(m.measurandId, m);

  for (const imp of doc.imports) {
    if (!resolver) throw new ParseError(`document imports ${imp.uri} but no resolver was supplied`);
    const src = await resolver.fetch(imp.uri);
    const idoc = parseDocument(src.data, src.format);
    imports.set(imp.uri, idoc);
    const prefix = imp.alias ? `${imp.alias}:` : "";
    for (const e of idoc.enums) {
      if (!enums.has(prefix + e.typeId)) enums.set(prefix + e.typeId, e);
    }
    for (const m of idoc.measurands) {
      if (!measurands.has(prefix + m.measurandId)) measurands.set(prefix + m.measurandId, m);
    }
  }
  return { doc, enums, measurands, imports };
}
