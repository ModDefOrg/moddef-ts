/**
 * Document layer (spec §4): parse and serialize the three equivalent
 * encodings — .moddef.yaml, .moddef.json, .moddef (proto binary).
 * YAML and JSON follow proto3 JSON (protojson) semantics; unknown fields and
 * invalid enum values are rejected, matching the Go implementation and the
 * fixtures under moddef/fixtures/invalid.
 *
 * Browser-safe: takes strings/bytes, never touches the filesystem. Node file
 * helpers live in `@moddef/core/node`.
 */

import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import YAML from "yaml";
import { ModDefDocumentSchema, type ModDefDocument } from "./schema/index.js";
import { ParseError } from "./errors.js";

export type DocumentFormat = "yaml" | "json" | "binary";

/** Infer the format from a file path per the spec §4 extensions. */
export function detectFormat(path: string): DocumentFormat {
  if (path.endsWith(".moddef.yaml") || path.endsWith(".moddef.yml")) return "yaml";
  if (path.endsWith(".moddef.json")) return "json";
  if (path.endsWith(".moddef")) return "binary";
  throw new ParseError(`cannot detect ModDef format from path: ${path}`);
}

/** Parse a document from text or bytes in the given (or detected) format. */
export function parseDocument(
  data: string | Uint8Array,
  format: DocumentFormat,
): ModDefDocument {
  try {
    switch (format) {
      case "binary": {
        const bytes =
          typeof data === "string" ? new TextEncoder().encode(data) : data;
        return fromBinary(ModDefDocumentSchema, bytes);
      }
      case "json": {
        const text =
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return fromJson(ModDefDocumentSchema, JSON.parse(text));
      }
      case "yaml": {
        const text =
          typeof data === "string" ? data : new TextDecoder().decode(data);
        // YAML is parsed to plain JSON values, then through protojson. This is
        // the same round-trip the Go loader uses (yaml -> JSON -> protojson).
        return fromJson(ModDefDocumentSchema, YAML.parse(text) ?? {});
      }
    }
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError(`failed to parse ModDef ${format} document: ${String(e)}`, {
      cause: e,
    });
  }
}

/** Serialize a document. yaml/json return string, binary returns bytes. */
export function serializeDocument(doc: ModDefDocument, format: "binary"): Uint8Array;
export function serializeDocument(doc: ModDefDocument, format: "yaml" | "json"): string;
export function serializeDocument(
  doc: ModDefDocument,
  format: DocumentFormat,
): string | Uint8Array {
  switch (format) {
    case "binary":
      return toBinary(ModDefDocumentSchema, doc);
    case "json":
      return JSON.stringify(toJson(ModDefDocumentSchema, doc), null, 2) + "\n";
    case "yaml":
      return YAML.stringify(toJson(ModDefDocumentSchema, doc));
  }
}

/** Create an empty document (useful for tests and programmatic construction). */
export function newDocument(): ModDefDocument {
  return create(ModDefDocumentSchema);
}

/**
 * Build a document from an in-memory protojson value (the shape produced by
 * `toJson`). Used by generated code to embed its source document without a
 * direct dependency on @bufbuild/protobuf.
 */
export function documentFromJsonValue(json: unknown): ModDefDocument {
  try {
    return fromJson(ModDefDocumentSchema, json as Parameters<typeof fromJson>[1]);
  } catch (e) {
    throw new ParseError(`failed to parse embedded ModDef document: ${String(e)}`, { cause: e });
  }
}
