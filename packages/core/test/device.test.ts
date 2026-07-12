// SPDX-License-Identifier: Apache-2.0

/**
 * Device facade tests (spec §32.4, §26): point reads across spaces, measurand
 * queries with ambiguity handling, SunSpec discovery with ID-relative model
 * offsets (spec §7.3), scale_ref companion reads, and constrained writes.
 */
import { describe, expect, it } from "vitest";
import { fromJson } from "@bufbuild/protobuf";
import {
  AmbiguousMeasurandError,
  Device,
  MeasurandNotSupportedError,
  PointNotFoundError,
  Unavailable,
  WriteAccessError,
  WriteConstraintError,
  schema,
} from "@moddef/core";
import { MockTransport } from "./mock-transport.js";

const doc = fromJson(schema.ModDefDocumentSchema, {
  docId: "test.meter",
  version: "1.0.0",
  devices: [
    {
      deviceId: "meter",
      vendor: "Test",
      model: "M1",
      blocks: [
        {
          blockId: "live",
          space: "INPUT_REGISTER",
          startOffset: 0,
          lengthWords: 16,
          points: [
            {
              pointId: "voltage_l1",
              name: "Voltage L1",
              access: "READ_ONLY",
              storageType: "U16",
              valueType: { primitive: "DECIMAL" },
              unit: "V",
              mapping: { space: "INPUT_REGISTER", offset: 0, lengthWords: 1 },
              transform: { scale: { numerator: "1", denominator: "10" } },
              measurand: { baseQuantity: "voltage", phaseRef: "L1_N" },
            },
            {
              pointId: "voltage_l2",
              name: "Voltage L2",
              access: "READ_ONLY",
              storageType: "U16",
              valueType: { primitive: "DECIMAL" },
              unit: "V",
              mapping: { space: "INPUT_REGISTER", offset: 1, lengthWords: 1 },
              transform: { scale: { numerator: "1", denominator: "10" } },
              measurand: { baseQuantity: "voltage", phaseRef: "L2_N" },
              naValues: [{ raw: "65535", meaning: "not_implemented" }],
            },
            {
              pointId: "frequency",
              name: "Frequency",
              access: "READ_ONLY",
              storageType: "U16",
              valueType: { primitive: "DECIMAL" },
              unit: "Hz",
              mapping: { space: "INPUT_REGISTER", offset: 2, lengthWords: 1 },
              transform: { scale: { numerator: "1", denominator: "100" } },
              measurand: { baseQuantity: "frequency" },
            },
          ],
        },
        {
          blockId: "settings",
          space: "HOLDING_REGISTER",
          startOffset: 0,
          lengthWords: 8,
          points: [
            {
              pointId: "stop_soc",
              name: "Stop SOC",
              access: "READ_WRITE",
              storageType: "U16",
              valueType: { primitive: "DECIMAL" },
              unit: "%",
              mapping: { space: "HOLDING_REGISTER", offset: 0, lengthWords: 1 },
              write: {
                behavior: "DIRECT",
                constraints: {
                  minValue: { numerator: "0", denominator: "1" },
                  maxValue: { numerator: "100", denominator: "1" },
                  step: { numerator: "1", denominator: "1" },
                },
              },
            },
            {
              pointId: "mode",
              name: "Mode",
              access: "READ_WRITE",
              storageType: "U16",
              valueType: { primitive: "UINT32" },
              mapping: { space: "HOLDING_REGISTER", offset: 1, lengthWords: 1 },
              write: { behavior: "DIRECT", constraints: { allowedValues: ["0", "1", "2"] } },
            },
            {
              pointId: "setpoint_scaled",
              name: "Scaled Setpoint",
              access: "READ_WRITE",
              storageType: "U16",
              valueType: { primitive: "DECIMAL" },
              mapping: { space: "HOLDING_REGISTER", offset: 2, lengthWords: 1 },
              transform: { scale: { numerator: "1", denominator: "10" } },
              write: { behavior: "DIRECT" },
            },
          ],
        },
      ],
    },
  ],
});

function makeDevice(): { dev: Device; m: MockTransport } {
  const m = new MockTransport();
  const dev = Device.create(doc, "meter", m);
  return { dev, m };
}

describe("point reads", () => {
  it("reads and scales input registers", async () => {
    const { dev, m } = makeDevice();
    m.input[0] = 2305;
    expect(await dev.readPoint("voltage_l1")).toBeCloseTo(230.5, 10);
  });

  it("returns Unavailable on sentinel", async () => {
    const { dev, m } = makeDevice();
    m.input[1] = 0xffff;
    expect(await dev.readPoint("voltage_l2")).toBeInstanceOf(Unavailable);
  });

  it("unknown point id throws PointNotFoundError", async () => {
    const { dev } = makeDevice();
    await expect(dev.readPoint("nope")).rejects.toBeInstanceOf(PointNotFoundError);
  });
});

describe("measurand queries (§26)", () => {
  it("unqualified unique match", async () => {
    const { dev, m } = makeDevice();
    m.input[2] = 4999;
    expect(await dev.readMeasurand({ baseQuantity: "frequency" })).toBeCloseTo(49.99, 10);
  });

  it("qualified phase match", async () => {
    const { dev, m } = makeDevice();
    m.input[0] = 2301;
    const v = await dev.readMeasurand({
      baseQuantity: "voltage",
      phaseRef: schema.PhaseRef.L1_N,
    });
    expect(v).toBeCloseTo(230.1, 10);
  });

  it("ambiguous query throws with the matching ids", async () => {
    const { dev } = makeDevice();
    await expect(dev.readMeasurand({ baseQuantity: "voltage" })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AmbiguousMeasurandError &&
        e.matches.join(",") === "voltage_l1,voltage_l2",
    );
  });

  it("unsupported measurand throws", async () => {
    const { dev } = makeDevice();
    await expect(dev.readMeasurand({ baseQuantity: "battery_power" })).rejects.toBeInstanceOf(
      MeasurandNotSupportedError,
    );
  });
});

describe("writes with constraints (§11.4)", () => {
  it("writes a valid value", async () => {
    const { dev, m } = makeDevice();
    await dev.writePoint("stop_soc", 80);
    expect(m.holding[0]).toBe(80);
  });

  it("rejects out-of-range and off-step values", async () => {
    const { dev } = makeDevice();
    await expect(dev.writePoint("stop_soc", 101)).rejects.toBeInstanceOf(WriteConstraintError);
    await expect(dev.writePoint("stop_soc", -1)).rejects.toBeInstanceOf(WriteConstraintError);
    await expect(dev.writePoint("stop_soc", 50.5)).rejects.toBeInstanceOf(WriteConstraintError);
  });

  it("rejects values outside allowed_values", async () => {
    const { dev, m } = makeDevice();
    await dev.writePoint("mode", 2);
    expect(m.holding[1]).toBe(2);
    await expect(dev.writePoint("mode", 3)).rejects.toBeInstanceOf(WriteConstraintError);
  });

  it("applies the inverse transform on write", async () => {
    const { dev, m } = makeDevice();
    await dev.writePoint("setpoint_scaled", 23.5);
    expect(m.holding[2]).toBe(235);
  });

  it("rejects writes to read-only points", async () => {
    const { dev } = makeDevice();
    await expect(dev.writePoint("voltage_l1" as never, 1)).rejects.toBeInstanceOf(WriteAccessError);
  });
});

describe("SunSpec discovery (§7.3, ID-relative offsets)", () => {
  const susDoc = fromJson(schema.ModDefDocumentSchema, {
    docId: "test.sunspec",
    version: "1.0.0",
    devices: [
      {
        deviceId: "inv",
        vendor: "Test",
        model: "S1",
        blocks: [
          {
            blockId: "inverter",
            space: "HOLDING_REGISTER",
            startOffset: 40070,
            lengthWords: 50,
            discovery: { kind: "SUNSPEC", anchorCandidates: [0, 40000, 50000], modelId: 103 },
            points: [
              {
                pointId: "w_sf",
                name: "Power SF",
                access: "READ_ONLY",
                storageType: "S16",
                valueType: { primitive: "INT32" },
                mapping: { space: "HOLDING_REGISTER", modelRelativeOffset: 15, lengthWords: 1 },
              },
              {
                pointId: "ac_power",
                name: "AC Power",
                access: "READ_ONLY",
                storageType: "S16",
                valueType: { primitive: "DECIMAL" },
                unit: "W",
                mapping: { space: "HOLDING_REGISTER", modelRelativeOffset: 14, lengthWords: 1 },
                transform: { scaleRef: { pointId: "w_sf", mode: "POW10" } },
                measurand: { baseQuantity: "active_power" },
              },
            ],
          },
        ],
      },
    ],
  });

  it("walks the model chain and resolves ID-relative offsets", async () => {
    const m = new MockTransport(41000);
    m.holding[40000] = 0x5375; // "Su"
    m.holding[40001] = 0x6e53; // "nS"
    m.holding[40002] = 1; //   model 1 header
    m.holding[40003] = 66;
    m.holding[40070] = 103; // model 103 header (= 40002 + 2 + 66)
    m.holding[40071] = 50;
    // Canonical model 103: W at ID+14, W_SF at ID+15.
    m.holding[40070 + 14] = 2301;
    m.holding[40070 + 15] = 0xffff; // sf = -1
    m.holding[40122] = 0xffff; // end of chain

    const dev = Device.create(susDoc, "inv", m);
    expect(await dev.readPoint("ac_power")).toBeCloseTo(230.1, 10);
    // Model base is cached: a second read must not re-probe the anchor.
    const probes = m.readLog.filter((l) => l === "H@40000x2").length;
    await dev.readPoint("ac_power");
    expect(m.readLog.filter((l) => l === "H@40000x2").length).toBe(probes);

    // The measurand path resolves through discovery too.
    expect(await dev.readMeasurand({ baseQuantity: "active_power" })).toBeCloseTo(230.1, 10);
  });
});
