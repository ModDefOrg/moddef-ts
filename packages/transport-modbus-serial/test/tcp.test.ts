// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter integration test: a real Modbus TCP round-trip against
 * modbus-serial's in-process ServerTCP, driving the core Device facade with
 * the golden energy-meter profile plus chunked-read and error mapping checks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { ServerTCP } from "modbus-serial";
import { Device, TransportError } from "@moddef/core";
import { loadDocument } from "@moddef/core/node";
import { ModbusSerialTransport } from "@moddef/transport-modbus-serial";

const PORT = 18502;
const moddefRepo = process.env.MODDEF_REPO ?? join(__dirname, "..", "..", "..", "..", "moddef");

const holding = new Uint16Array(4096);
const input = new Uint16Array(4096);
const coils: boolean[] = new Array(1024).fill(false);

let server: InstanceType<typeof ServerTCP>;
let transport: ModbusSerialTransport;

beforeAll(async () => {
  server = new ServerTCP(
    {
      getHoldingRegister: (addr: number) => holding[addr] ?? 0,
      getInputRegister: (addr: number) => input[addr] ?? 0,
      getMultipleHoldingRegisters: (addr: number, n: number) => [...holding.slice(addr, addr + n)],
      getMultipleInputRegisters: (addr: number, n: number) => [...input.slice(addr, addr + n)],
      getCoil: (addr: number) => coils[addr] ?? false,
      setRegister: (addr: number, value: number) => {
        holding[addr] = value & 0xffff;
      },
      setCoil: (addr: number, value: boolean) => {
        coils[addr] = value;
      },
    },
    { host: "127.0.0.1", port: PORT, unitID: 1 },
  );
  await new Promise((resolve) => server.on("initialized", resolve));
  transport = await ModbusSerialTransport.tcp("127.0.0.1", {
    port: PORT,
    unitId: 1,
    timeoutMs: 2000,
    maxReadWords: 11, // exercise chunking (EM24-style read window)
  });
});

afterAll(async () => {
  await transport.close();
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

describe("ModbusSerialTransport over TCP", () => {
  it("raw chunked reads cross the maxReadWords window", async () => {
    for (let i = 0; i < 30; i++) holding[100 + i] = i + 1;
    const regs = await transport.readHolding(100, 30);
    expect([...regs]).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("drives the Device facade end-to-end (golden energy-meter profile)", async () => {
    const doc = await loadDocument(
      join(moddefRepo, "fixtures", "golden", "energy-meter", "energy-meter.moddef.yaml"),
    );
    const dev = Device.create(doc, undefined, transport);
    const infos = dev.points();
    expect(infos.length).toBeGreaterThan(0);

    // Seed the first scaled numeric point and read it back through the stack.
    const target = infos.find(
      (i) =>
        (i.point.storageType === 2 || i.point.storageType === 3) && // U16/S16
        i.point.transform?.scale !== undefined &&
        i.point.mapping !== undefined,
    );
    expect(target).toBeDefined();
    const p = target!.point;
    const space = p.mapping!.space || target!.block.space;
    const image = space === 3 ? input : holding; // 3 = INPUT_REGISTER
    image[p.mapping!.offset] = 1234;
    const scale = p.transform!.scale!;
    const expected = (1234 * Number(scale.numerator)) / Number(scale.denominator);
    expect(await dev.readPoint(p.pointId)).toBeCloseTo(expected, 9);
  });

  it("serializes concurrent requests (promise queue)", async () => {
    for (let i = 0; i < 8; i++) input[200 + i] = 42 + i;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => transport.readInput(200 + i, 1)),
    );
    results.forEach((r, i) => expect(r[0]).toBe(42 + i));
  });

  it("maps illegal addresses to TransportError", async () => {
    await expect(transport.readHolding(60000, 10)).rejects.toBeInstanceOf(TransportError);
  });

  it("writes registers and coils", async () => {
    await transport.writeHolding(300, [7]);
    expect(holding[300]).toBe(7);
    await transport.writeHolding(301, [1, 2, 3]);
    expect([holding[301], holding[302], holding[303]]).toEqual([1, 2, 3]);
    await transport.writeCoil(5, true);
    expect(coils[5]).toBe(true);
  });
});
