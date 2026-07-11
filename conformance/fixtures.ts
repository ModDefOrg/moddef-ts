/** Shared paths into the sibling moddef repo's compliance fixtures (spec §33). */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));

/** Root of the sibling moddef checkout (override with MODDEF_REPO). */
export const moddefRepo = process.env.MODDEF_REPO ?? join(here, "..", "..", "moddef");
export const fixturesDir = join(moddefRepo, "fixtures");
export const stdlibDir = join(moddefRepo, "stdlib");
export const devicesDir = process.env.MODDEF_DEVICES ?? join(here, "..", "..", "devices");

export interface ManifestGolden {
  name: string;
  files: { json: string; yaml: string; binary: string };
  roundtrip: string;
  schema: string;
}
export interface ManifestInvalid {
  rule: string;
  file: string;
  severity: string;
  exit_code: number;
  schema_valid: boolean;
  description: string;
}
export interface Manifest {
  golden: ManifestGolden[];
  invalid: ManifestInvalid[];
}

export function loadManifest(): Manifest {
  return YAML.parse(readFileSync(join(fixturesDir, "manifest.yaml"), "utf8")) as Manifest;
}
