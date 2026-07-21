// SPDX-License-Identifier: Apache-2.0

/**
 * @moddef/core — ModDef runtime for TypeScript (spec v0.4).
 * Browser-safe entry: no Node builtins. File helpers live in "@moddef/core/node".
 */

// The proto schema is exported as a namespace to avoid clashes between the
// proto `Transport` enum and the runtime `Transport` interface.
export * as schema from "./schema/index.js";
export * from "./values.js";
export * from "./errors.js";
export * from "./document.js";
export * from "./resolve.js";
export * from "./transport.js";
export * from "./measurand.js";
export * from "./device.js";
export * from "./command.js";
export { decodePoint, decodePointRaw, emptyContext, storageBits, isSigned } from "./codec/decode.js";
export type { CodecContext } from "./codec/decode.js";
export { encodePoint, words } from "./codec/encode.js";
export type { EncodableValue } from "./codec/encode.js";
export { allPoints, referencedPoints, resolveContext, decodeAll, asInt } from "./codec/context.js";
