// SPDX-License-Identifier: Apache-2.0

/**
 * Generator tests (spec §33 "code generation tests"):
 *  - deterministic snapshot for a golden fixture,
 *  - generated output for every golden fixture and every blessed registry
 *    profile passes `tsc --noEmit`,
 *  - end-to-end: generated classes drive a mock transport with typed values.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDocument } from "@moddef/core/node";
import { generate } from "@moddef/codegen";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const moddefRepo = process.env.MODDEF_REPO ?? join(repoRoot, "..", "moddef");
const devicesDir = process.env.MODDEF_DEVICES ?? join(repoRoot, "..", "devices");
const outDir = join(repoRoot, "test-output", "gen");

const goldenDocs = [
  join(moddefRepo, "fixtures", "golden", "energy-meter", "energy-meter.moddef.yaml"),
  join(moddefRepo, "fixtures", "golden", "battery-control", "battery-control.moddef.yaml"),
  join(moddefRepo, "fixtures", "golden", "sunspec-inverter", "sunspec-inverter.moddef.yaml"),
];
const registryProfiles = [
  "solar-inverter/growatt-sph/growatt-sph.moddef.yaml",
  "solar-inverter/fronius-gen24/fronius-gen24.moddef.yaml",
  "energy-meter/eastron-sdm630/eastron-sdm630.moddef.yaml",
  "energy-meter/abb-b23/abb-b23.moddef.yaml",
  "energy-meter/carlo-gavazzi-em24/carlo-gavazzi-em24.moddef.yaml",
  "battery-storage/victron-venus-os/victron-venus-os.moddef.yaml",
  "ev-charger/abb-terra-ac/abb-terra-ac.moddef.yaml",
  "hvac/daikin-altherma-3/daikin-altherma-3.moddef.yaml",
].map((p) => join(devicesDir, p));

beforeAll(async () => {
  await mkdir(outDir, { recursive: true });
});

describe("snapshot", () => {
  it("battery-control fixture is stable", async () => {
    const doc = await loadDocument(goldenDocs[1]!);
    const files = generate(doc);
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toMatchSnapshot();
    // Determinism: generating twice yields identical output.
    expect(generate(doc)[0]!.content).toBe(files[0]!.content);
  });
});

describe("generated output typechecks", () => {
  it("tsc --noEmit passes for goldens + all registry profiles", async () => {
    const emitted: string[] = [];
    for (const src of [...goldenDocs, ...registryProfiles]) {
      const doc = await loadDocument(src);
      for (const f of generate(doc)) {
        const p = join(outDir, f.path);
        await writeFile(p, f.content, "utf8");
        emitted.push(f.path);
      }
    }
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: emitted,
    };
    await writeFile(join(outDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    // Resolve @moddef/core from the workspace root node_modules.
    await run("npx", ["tsc", "-p", outDir], { cwd: repoRoot });
  }, 120000);
});

describe("end-to-end against a mock transport", () => {
  it("growatt-sph: enums, packed fields, flags, constrained writes", async () => {
    const doc = await loadDocument(registryProfiles[0]!);
    const file = generate(doc)[0]!;
    const p = join(outDir, "e2e-growatt.ts");
    await writeFile(p, file.content, "utf8");
    const mod = await import(/* @vite-ignore */ pathToFileURL(p).href);

    const { MockTransport } = await import("../../core/test/mock-transport.js");
    const m = new MockTransport(2048);
    const dev = new mod.GrowattSph(m);

    m.input[0] = 1; // NORMAL
    expect(await dev.inverterStatus()).toBe(mod.InverterRunState.NORMAL);

    m.holding[1080] = (21 << 8) | 45; // grid-first slot 1 start 21:45
    expect(await dev.gridFirstSlot1Start()).toEqual({ hour: 21, minute: 45 });

    m.holding[1] = 0b100001; // SPI + DRMS enables
    expect(await dev.safetyFunctionEnable()).toEqual(["spi_enable", "drms_enable"]);

    await dev.setAcChargeEnable(mod.EnableState.ENABLED);
    expect(m.holding[1092]).toBe(1);
    await expect(dev.setAcChargeEnable(5)).rejects.toThrow(/allowed_values/);

    // Scaled decimal read: PV1 voltage 0.1 V at input 3.
    m.input[3] = 2450;
    expect(await dev.pv1Voltage()).toBeCloseTo(245.0, 10);
  });

  it("eastron-sdm630: float32 points and measurand convenience", async () => {
    const doc = await loadDocument(registryProfiles[2]!);
    const file = generate(doc)[0]!;
    const p = join(outDir, "e2e-sdm630.ts");
    await writeFile(p, file.content, "utf8");
    const mod = await import(/* @vite-ignore */ pathToFileURL(p).href);

    const { MockTransport } = await import("../../core/test/mock-transport.js");
    const m = new MockTransport(1024);
    const dev = new mod.EastronSdm630(m);

    // 230.5f big endian at input 0 (voltage L1-N), 50.0f at input 70 (frequency).
    m.input[0] = 0x4366;
    m.input[1] = 0x8000;
    m.input[70] = 0x4248;
    m.input[71] = 0x0000;

    expect(await dev.voltageL1N()).toBeCloseTo(230.5, 4);
    expect(await dev.getFrequency()).toBeCloseTo(50.0, 4);
    expect(await dev.getVoltage({ phase: "L1_N" })).toBeCloseTo(230.5, 4);
    await expect(dev.getVoltage({})).rejects.toThrow(/ambiguous/);
  });
});
