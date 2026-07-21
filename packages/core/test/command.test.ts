// SPDX-License-Identifier: Apache-2.0

/**
 * Command executor tests (spec §11.7): linear step order, param/trigger
 * writes, poll conditions on raw values with timeout, length_ref-sized
 * reads, chunked >1-PDU transfers, and result assembly from bindings.
 */
import { describe, expect, it } from "vitest";
import { fromJson } from "@bufbuild/protobuf";
import {
  CommandNotFoundError,
  Device,
  PollTimeoutError,
  RequiredParamMissingError,
  conditionMet,
  schema,
} from "@moddef/core";
import { MockTransport } from "./mock-transport.js";

/** MockTransport with per-offset successive reads and an ordered write log. */
class CmdTransport extends MockTransport {
  seq = new Map<number, number[]>();
  writes: Array<{ off: number; vals: number[] }> = [];

  override async readHolding(offset: number, quantity: number): Promise<Uint16Array> {
    const vals = this.seq.get(offset);
    if (vals && vals.length > 0) {
      const v = vals.length > 1 ? vals.shift()! : vals[0]!;
      return Uint16Array.of(v);
    }
    return super.readHolding(offset, quantity);
  }

  override async writeHolding(offset: number, values: ArrayLike<number>): Promise<void> {
    this.writes.push({ off: offset, vals: Array.from(values) });
    return super.writeHolding(offset, values);
  }
}

const doc = fromJson(schema.ModDefDocumentSchema, {
  docId: "test.commands",
  version: "1.0.0",
  devices: [
    {
      deviceId: "cmd-device",
      vendor: "Test",
      model: "CMD-1",
      blocks: [
        {
          blockId: "job",
          space: "HOLDING_REGISTER",
          startOffset: 0,
          lengthWords: 1000,
          points: [
            {
              pointId: "control",
              access: "COMMAND",
              storageType: "U16",
              valueType: { primitive: "UINT32" },
              mapping: { space: "HOLDING_REGISTER", offset: 10, lengthWords: 1 },
              write: { behavior: "COMMAND_TRIGGER" },
            },
            {
              pointId: "status",
              access: "READ_ONLY",
              storageType: "U16",
              valueType: { primitive: "UINT32" },
              mapping: { space: "HOLDING_REGISTER", offset: 11, lengthWords: 1 },
            },
            {
              pointId: "busy_flags",
              access: "READ_ONLY",
              storageType: "U16",
              valueType: { primitive: "UINT32" },
              mapping: { space: "HOLDING_REGISTER", offset: 12, lengthWords: 1 },
            },
            {
              pointId: "result_length",
              access: "READ_ONLY",
              storageType: "U16",
              valueType: { primitive: "UINT32" },
              mapping: { space: "HOLDING_REGISTER", offset: 20, lengthWords: 1 },
            },
            {
              pointId: "result_data",
              access: "READ_ONLY",
              storageType: "BYTES_RAW",
              valueType: { primitive: "BYTES" },
              mapping: {
                space: "HOLDING_REGISTER",
                offset: 21,
                lengthWords: 8,
                byteOrder: "BIG_ENDIAN",
                wordOrder: "WORD_BIG_ENDIAN",
                lengthRef: { pointId: "result_length" },
              },
            },
            {
              pointId: "blob",
              access: "READ_ONLY",
              storageType: "BYTES_RAW",
              valueType: { primitive: "BYTES" },
              mapping: { space: "HOLDING_REGISTER", offset: 500, lengthWords: 300 },
            },
          ],
        },
      ],
      commands: [
        {
          commandId: "run_job",
          params: [
            {
              field: "payload",
              storageType: "BYTES_RAW",
              valueType: { primitive: "BYTES" },
              mapping: { space: "HOLDING_REGISTER", offset: 0, lengthWords: 4 },
            },
            {
              field: "mode",
              storageType: "U16",
              valueType: { primitive: "UINT32" },
              mapping: { space: "HOLDING_REGISTER", offset: 5, lengthWords: 1 },
              required: true,
            },
          ],
          steps: [
            { name: "write_payload", write: { param: "payload" } },
            { name: "write_mode", write: { param: "mode" } },
            { name: "arm", write: { trigger: { pointId: "control", value: "1" } } },
            {
              name: "wait_not_busy",
              poll: {
                pointId: "busy_flags",
                until: { op: "MASK", mask: "1", value: "0" },
                intervalMs: 2,
                timeoutMs: 500,
              },
            },
            {
              name: "wait_done",
              poll: {
                pointId: "status",
                until: { op: "EQ", value: "0" },
                intervalMs: 2,
                timeoutMs: 500,
              },
            },
            { name: "fetch_length", read: { pointId: "result_length", into: "length" } },
            { name: "fetch_data", read: { pointId: "result_data", into: "data" } },
          ],
          results: [
            { field: "data", from: "data", valueType: { primitive: "BYTES" } },
            { field: "length", from: "length", valueType: { primitive: "UINT32" } },
          ],
        },
        {
          commandId: "wait_forever",
          steps: [
            {
              name: "poll",
              poll: {
                pointId: "status",
                until: { op: "EQ", value: "9" },
                intervalMs: 2,
                timeoutMs: 20,
              },
            },
          ],
          results: [],
        },
        {
          commandId: "xfer",
          params: [
            {
              field: "input",
              storageType: "BYTES_RAW",
              valueType: { primitive: "BYTES" },
              mapping: { space: "HOLDING_REGISTER", offset: 600, lengthWords: 200 },
              required: true,
            },
          ],
          steps: [
            { name: "w", write: { param: "input" } },
            { name: "r", read: { pointId: "blob", into: "blob" } },
          ],
          results: [{ field: "blob", from: "blob" }],
        },
      ],
    },
  ],
});

function device(t: CmdTransport): Device {
  return Device.create(doc, "cmd-device", t);
}

describe("runCommand", () => {
  it("runs write → poll → read and assembles results", async () => {
    const t = new CmdTransport();
    t.seq.set(12, [1, 0]); // busy clears on the second poll
    t.seq.set(11, [5, 0]); // status goes 0 on the second poll
    t.holding[20] = 2; // result_length: 2 of the 8-word window
    t.holding[21] = 0xdead;
    t.holding[22] = 0xbeef;
    t.holding[23] = 0xffff; // beyond the live length; must not be included

    const out = await device(t).runCommand("run_job", {
      mode: 7,
      payload: Uint8Array.of(1, 2, 3, 4),
    });

    // Step wire order: payload @0, mode @5, trigger @10.
    expect(t.writes.map((w) => w.off)).toEqual([0, 5, 10]);
    expect(t.writes[0]!.vals).toEqual([0x0102, 0x0304, 0, 0]);
    expect(t.writes[1]!.vals).toEqual([7]);
    expect(t.writes[2]!.vals).toEqual([1]);

    // length_ref-sized read: 2 words -> 4 bytes, not the 8-word clamp.
    expect(out.get("data")).toEqual(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    expect(out.get("length")).toBe(2);
  });

  it("honours length_ref on plain readPoint too", async () => {
    const t = new CmdTransport();
    t.holding[20] = 3;
    t.holding[21] = 0x0102;
    t.holding[22] = 0x0304;
    t.holding[23] = 0x0506;
    const v = await device(t).readPoint("result_data");
    expect(v).toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6));
  });

  it("rejects unknown commands and missing required params", async () => {
    const t = new CmdTransport();
    await expect(device(t).runCommand("nope")).rejects.toBeInstanceOf(CommandNotFoundError);
    await expect(
      device(t).runCommand("run_job", { payload: Uint8Array.of(1) }),
    ).rejects.toBeInstanceOf(RequiredParamMissingError);
  });

  it("times out a poll that never satisfies its condition", async () => {
    const t = new CmdTransport();
    await expect(device(t).runCommand("wait_forever")).rejects.toBeInstanceOf(PollTimeoutError);
  });

  it("chunks >1-PDU transfers (123-word writes, 125-word reads)", async () => {
    const t = new CmdTransport();
    const out = await device(t).runCommand("xfer", { input: new Uint8Array(400) });
    expect(t.writes.map((w) => w.vals.length)).toEqual([123, 77]);
    expect(t.writes[1]!.off).toBe(600 + 123);
    expect((out.get("blob") as Uint8Array).length).toBe(600);
  });
});

describe("conditionMet", () => {
  const cond = (json: object) => fromJson(schema.ConditionSchema, json);
  it("evaluates all four ops", () => {
    expect(conditionMet(cond({ op: "EQ", value: "5" }), 5n)).toBe(true);
    expect(conditionMet(cond({ op: "EQ", value: "5" }), 4n)).toBe(false);
    expect(conditionMet(cond({ op: "NE", value: "5" }), 4n)).toBe(true);
    expect(conditionMet(cond({ op: "NE", value: "5" }), 5n)).toBe(false);
    expect(conditionMet(cond({ op: "MASK", mask: "15", value: "3" }), 0xf3n)).toBe(true);
    expect(conditionMet(cond({ op: "MASK", mask: "15", value: "3" }), 0xf4n)).toBe(false);
    expect(conditionMet(cond({ op: "RANGE", min: "10", max: "20" }), 15n)).toBe(true);
    expect(conditionMet(cond({ op: "RANGE", min: "10", max: "20" }), 21n)).toBe(false);
    expect(conditionMet(undefined, 0n)).toBe(false);
  });
});
