// SPDX-License-Identifier: Apache-2.0

/**
 * Node example: drive a Growatt SPH hybrid inverter with the generated typed
 * client over Modbus RTU (or TCP via a serial gateway).
 *
 * Generate the client first:
 *   npx moddef-ts gen -o ./generated ../../../devices/solar-inverter/growatt-sph/growatt-sph.moddef.yaml
 *
 * Then: npx tsx main.ts /dev/ttyUSB0
 */
import { ModbusSerialTransport } from "@moddef/transport-modbus-serial";
import { isUnavailable } from "@moddef/core";
import { GrowattSph, InverterRunState, EnableState } from "./generated/growatt-sph.js";

const port = process.argv[2] ?? "/dev/ttyUSB0";

const transport = await ModbusSerialTransport.rtu(port, {
  baudRate: 9600,
  unitId: 1,
  timeoutMs: 1500,
});
const inverter = new GrowattSph(transport);

// Typed telemetry — return types are literal unions / numbers, not `any`.
const status = await inverter.inverterStatus(); // InverterRunState = 0 | 1 | 3
switch (status) {
  case InverterRunState.WAITING:
    console.log("inverter is waiting");
    break;
  case InverterRunState.NORMAL:
    console.log("inverter feeding in");
    break;
  case InverterRunState.FAULT: {
    console.log("FAULT", await inverter.faultMaincode(), await inverter.faultSubcode());
    break;
  }
}

console.log("PV power     :", await inverter.pvPowerTotal(), "W");
console.log("Battery SOC  :", await inverter.stateOfCharge(), "%");
console.log("Grid power   :", await inverter.acPowerToGrid(), "W");

const soc = await inverter.bmsSoc();
if (!isUnavailable(soc)) console.log("BMS SOC      :", soc, "%");

// Time-slot schedule (packed hour/minute register fields, typed object).
const slot = await inverter.gridFirstSlot1Start();
console.log(`Grid-first slot 1 starts ${slot.hour}:${String(slot.minute).padStart(2, "0")}`);

// Writes validate §11.4 constraints before touching the wire.
await inverter.setBatFirstStopSoc(90);
await inverter.setAcChargeEnable(EnableState.ENABLED);

await transport.close();
