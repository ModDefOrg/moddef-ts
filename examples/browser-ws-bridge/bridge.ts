/**
 * Node WebSocket -> Modbus bridge for the browser example. One bridge, one
 * device connection; the adapter's promise queue serializes browser requests.
 *
 *   npx tsx bridge.ts --tcp 192.168.1.50        # or --rtu /dev/ttyUSB0
 */
import { WebSocketServer } from "ws";
import { ModbusSerialTransport } from "@moddef/transport-modbus-serial";
import type { Transport } from "@moddef/core";

const args = process.argv.slice(2);
const mode = args[0] ?? "--tcp";
const target = args[1] ?? "127.0.0.1";

const transport: Transport & { close(): Promise<void> } =
  mode === "--rtu"
    ? await ModbusSerialTransport.rtu(target, { baudRate: 9600, unitId: 1 })
    : await ModbusSerialTransport.tcp(target, { unitId: 1 });

const wss = new WebSocketServer({ port: 8502 });
console.error("bridge listening on ws://localhost:8502");

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    const req = JSON.parse(String(raw));
    const opts = { unitId: req.unitId };
    try {
      let data: unknown;
      switch (req.op) {
        case "readHolding":
          data = [...(await transport.readHolding(req.offset, req.quantity, opts))];
          break;
        case "readInput":
          data = [...(await transport.readInput(req.offset, req.quantity, opts))];
          break;
        case "readCoils":
          data = await transport.readCoils(req.offset, req.quantity, opts);
          break;
        case "readDiscrete":
          data = await transport.readDiscrete(req.offset, req.quantity, opts);
          break;
        case "writeHolding":
          await transport.writeHolding(req.offset, req.values, opts);
          data = [];
          break;
        case "writeCoil":
          await transport.writeCoil(req.offset, req.value, opts);
          data = [];
          break;
        default:
          throw new Error(`unknown op ${req.op}`);
      }
      ws.send(JSON.stringify({ id: req.id, ok: true, data }));
    } catch (e) {
      const err = e as { message?: string; exceptionCode?: number };
      ws.send(JSON.stringify({ id: req.id, ok: false, error: err.message, code: err.exceptionCode }));
    }
  });
});
