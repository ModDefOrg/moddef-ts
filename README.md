# moddef-ts

TypeScript implementation of [ModDef](../moddef) (spec v0.4): a runtime for
reading and writing Modbus devices described by `.moddef` documents, and a
code generator that turns device profiles into fully typed client classes.

| Package | What it is |
|---|---|
| [`@moddef/core`](packages/core) | Document loading (YAML/JSON/binary), Modbus codec, `Transport` interface, typed errors, runtime `Device` facade (incl. SunSpec discovery, `scale_ref`, measurand queries). Isomorphic — Node and browser. |
| [`@moddef/codegen`](packages/codegen) | Generator + `moddef-ts` CLI. Emits const-object enums with literal-union types, an `as const` point catalog, and a typed device class per profile with §26.2 measurand convenience methods. |
| [`@moddef/transport-modbus-serial`](packages/transport-modbus-serial) | `Transport` adapter for the `modbus-serial` package (RTU + TCP, Node only), with request serialization, chunked reads and Modbus exception mapping. |

## Quick start

```bash
npm install
npm run build

# Generate a typed client from a blessed registry profile
node packages/codegen/dist/cli.js gen -o ./gen \
  ../devices/solar-inverter/growatt-sph/growatt-sph.moddef.yaml
```

```ts
import { ModbusSerialTransport } from "@moddef/transport-modbus-serial";
import { GrowattSph, InverterRunState } from "./gen/growatt-sph.js";

const transport = await ModbusSerialTransport.rtu("/dev/ttyUSB0", { baudRate: 9600, unitId: 1 });
const inverter = new GrowattSph(transport);

const status = await inverter.inverterStatus();       // 0 | 1 | 3 (literal union)
const slot = await inverter.gridFirstSlot1Start();    // { hour: number; minute: number }
await inverter.setAcChargeEnable(1);                  // write constraints validated
const v = await inverter.getVoltage({ phase: "L1_N" }); // measurand convenience (§26.2)
```

Browsers: `@moddef/core` and generated code are browser-safe; implement
`Transport` over a bridge (see `examples/browser-ws-bridge`).

## Development

```bash
npm test               # vitest: codec/facade/codegen/adapter + conformance
npm run typecheck      # tsc -b over all packages
npm run smoke:browser  # esbuild browser-platform bundle, no externals
npm run sync-schema    # re-vendor protobuf-es types from ../moddef/gen/ts
```

Conformance tests drive the shared fixtures in `../moddef/fixtures` and the
device registry in `../devices` (override with `MODDEF_REPO` /
`MODDEF_DEVICES`). See [DESIGN.md](DESIGN.md) for architecture and the
deviations log.
