# @moddef/core

ModDef runtime (spec v0.4): document parsing (`.moddef.yaml` / `.moddef.json`
/ binary `.moddef`), the Modbus codec (all storage/value types, endianness,
scaling incl. SunSpec `scale_ref`, sentinels, flags, register fields,
datetime), the `Transport` interface, typed errors, and the `Device` facade
(point + measurand reads, constrained writes, SunSpec model-chain discovery).

Isomorphic: the root entry uses no Node builtins. Filesystem helpers
(`loadDocument`, `dirResolver`) live in `@moddef/core/node`.

```ts
import { Device, parseDocument } from "@moddef/core";
import { loadDocument } from "@moddef/core/node";

const doc = await loadDocument("growatt-sph.moddef.yaml");
const dev = Device.create(doc, "growatt-sph", transport);
const soc = await dev.readPoint("state_of_charge");
const hz = await dev.readMeasurand({ baseQuantity: "frequency" });
```
