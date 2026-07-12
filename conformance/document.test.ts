// SPDX-License-Identifier: Apache-2.0

/**
 * Fixture conformance (spec §33): YAML / JSON / binary triples must parse to
 * equal documents and round-trip losslessly; invalid documents must be
 * rejected at parse time when the manifest marks them schema-invalid.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toBinary, toJson, equals } from "@bufbuild/protobuf";
import { parseDocument, serializeDocument, ParseError, schema } from "@moddef/core";
import { loadDocument } from "@moddef/core/node";
import { fixturesDir, devicesDir, loadManifest } from "./fixtures.js";

const manifest = loadManifest();

describe("golden fixture equivalence", () => {
  for (const g of manifest.golden) {
    it(`${g.name}: yaml == json == binary`, () => {
      const yamlDoc = parseDocument(readFileSync(join(fixturesDir, g.files.yaml), "utf8"), "yaml");
      const jsonDoc = parseDocument(readFileSync(join(fixturesDir, g.files.json), "utf8"), "json");
      const binDoc = parseDocument(new Uint8Array(readFileSync(join(fixturesDir, g.files.binary))), "binary");

      expect(equals(schema.ModDefDocumentSchema, yamlDoc, jsonDoc)).toBe(true);
      expect(equals(schema.ModDefDocumentSchema, yamlDoc, binDoc)).toBe(true);
    });

    it(`${g.name}: lossless round-trip through every format`, () => {
      const doc = parseDocument(readFileSync(join(fixturesDir, g.files.yaml), "utf8"), "yaml");

      const viaJson = parseDocument(serializeDocument(doc, "json"), "json");
      const viaYaml = parseDocument(serializeDocument(doc, "yaml"), "yaml");
      const viaBin = parseDocument(serializeDocument(doc, "binary"), "binary");

      for (const round of [viaJson, viaYaml, viaBin]) {
        expect(equals(schema.ModDefDocumentSchema, doc, round)).toBe(true);
      }
      // Binary equivalence with the checked-in .moddef bytes.
      const goldenBin = new Uint8Array(readFileSync(join(fixturesDir, g.files.binary)));
      expect(toBinary(schema.ModDefDocumentSchema, doc)).toEqual(goldenBin);
    });
  }
});

describe("invalid fixtures are rejected", () => {
  for (const inv of manifest.invalid.filter((i) => !i.schema_valid)) {
    it(`${inv.rule}: ${inv.description}`, () => {
      const raw = readFileSync(join(fixturesDir, inv.file), "utf8");
      expect(() => parseDocument(raw, "json")).toThrow(ParseError);
    });
  }
});

describe("blessed device registry parses", () => {
  const profiles = [
    "solar-inverter/growatt-sph/growatt-sph.moddef.yaml",
    "solar-inverter/fronius-gen24/fronius-gen24.moddef.yaml",
    "energy-meter/eastron-sdm630/eastron-sdm630.moddef.yaml",
    "energy-meter/abb-b23/abb-b23.moddef.yaml",
    "energy-meter/carlo-gavazzi-em24/carlo-gavazzi-em24.moddef.yaml",
    "battery-storage/victron-venus-os/victron-venus-os.moddef.yaml",
    "ev-charger/abb-terra-ac/abb-terra-ac.moddef.yaml",
    "hvac/daikin-altherma-3/daikin-altherma-3.moddef.yaml",
  ];
  for (const rel of profiles) {
    it(rel, async () => {
      const doc = await loadDocument(join(devicesDir, rel));
      expect(doc.docId).toBeTruthy();
      expect(doc.devices.length).toBeGreaterThan(0);
      // JSON round-trip is lossless for real-world profiles too.
      const round = parseDocument(serializeDocument(doc, "json"), "json");
      expect(toJson(schema.ModDefDocumentSchema, round)).toEqual(toJson(schema.ModDefDocumentSchema, doc));
    });
  }
});
