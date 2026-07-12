// SPDX-License-Identifier: Apache-2.0

/** Test helpers: build Point messages from protojson-shaped literals. */
import { fromJson } from "@bufbuild/protobuf";
import { schema } from "@moddef/core";
import type { JsonValue } from "@bufbuild/protobuf";

export function point(json: JsonValue): schema.Point {
  return fromJson(schema.PointSchema, json);
}
