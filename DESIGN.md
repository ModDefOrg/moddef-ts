# moddef-ts — TypeScript Runtime + Generator

Design plan for the TypeScript implementation of ModDef (spec v0.4), following
the layering mandated by `moddef/spec/moddef_spec_v0_4.md` §31 (Code
Generation) and §32 (Client Library Architecture), with the Go implementation
(`moddef/go/{core,resolve,codec,client,gen}`) as the behavioral reference.

## Goals

- **`@moddef/core`** runtime: document loading, codec, transport interface,
  error types, untyped device facade. Isomorphic (Node + browser).
- **`@moddef/codegen`**: generator that emits typed TS device classes with
  full type narrowing on enums, flags, and register fields.
- **`@moddef/transport-modbus-serial`**: Node adapter for the `modbus-serial`
  package (RTU + TCP).
- Conformance against the shared fixtures in `moddef/fixtures` (§33).

Non-goals for v0.1: writing YAML back out with comments, the linter (stays in
Go), hardware-in-loop tests, a Web Serial transport (follow-up).

## Repository layout

```
moddef-ts/
  package.json               # pnpm workspace root
  tsconfig.base.json
  packages/
    core/                    # @moddef/core
      src/
        schema/              # vendored protobuf-es output (see "Schema types")
        document.ts          # parse/serialize YAML | JSON | binary .moddef
        resolve.ts           # import resolution (PackageResolver interface)
        codec/
          decode.ts          # decodePoint(point, regs, ctx)
          encode.ts          # encodePoint(point, value, ctx)
          bytes.ts           # register<->byte assembly, endianness
        transport.ts         # Transport interface (§32.3)
        errors.ts            # typed error classes (§26.3/26.4)
        device.ts            # runtime Device facade (§32.4, untyped)
        measurand.ts         # MeasurandQuery + matching
        index.ts             # browser-safe entry
        node.ts              # Node-only conveniences (loadFile, dir resolver)
    codegen/                 # @moddef/codegen — library + CLI (bin: moddef-ts)
      src/
        generate.ts          # generate(doc, opts): GeneratedFile[]
        emit-enums.ts
        emit-points.ts
        emit-device.ts
        naming.ts            # snake->camel/Pascal, collision policy
        cli.ts
    transport-modbus-serial/ # @moddef/transport-modbus-serial (Node-only)
      src/index.ts
  conformance/               # tests wired to ../moddef/fixtures + ../devices
  examples/
    node-growatt-rtu/
    browser-ws-bridge/
```

pnpm workspaces; TypeScript 5.x; `vitest` for tests; `tsup` for dual ESM+CJS
builds of each package; target ES2022 (bigint required). `@moddef/core` uses
no Node builtins (no `Buffer` — `Uint8Array`/`DataView` only); the `yaml` and
`@bufbuild/protobuf` dependencies are both isomorphic.

## Schema types

`moddef/gen/ts/moddef/v1/*.ts` already contains protoc-gen-es v2 output
(`target=ts`, runtime `@bufbuild/protobuf` ^2) for the five proto files. The
moddef repo stays the source of truth (buf.gen.yaml); moddef-ts **vendors** a
copy into `packages/core/src/schema/` via a `pnpm sync-schema` script that
copies from `../moddef/gen/ts`. CI fails if the vendored copy drifts.
Re-exported from `@moddef/core` as `import { schema } from '@moddef/core'`.

## @moddef/core

### document.ts (spec §4, mirrors go/core/document.go)

YAML and JSON are protojson-equivalent; binary is proto wire format:

```ts
parseDocument(data: string | Uint8Array, format?: 'yaml'|'json'|'binary'): ModDefDocument
serializeDocument(doc, format): string | Uint8Array
detectFormat(path: string): Format          // .moddef.yaml/.moddef.json/.moddef
```

YAML path: `yaml.parse()` → `fromJson(ModDefDocumentSchema, …)` (protojson
semantics, unknown fields rejected — matches Go strictness and the
PARSE_UNKNOWN_FIELD invalid fixture). Core takes bytes/strings only; reading
files lives in `@moddef/core/node` (`loadDocument(path)`).

### resolve.ts (spec §19, mirrors go/resolve)

```ts
interface PackageResolver {
  fetch(uri: string): Promise<Uint8Array | string>  // 'moddef:stdlib:measurands:1.0.0'
}
resolveImports(doc, resolver): Promise<ResolvedDocument>  // merged enums/measurands/structs
```

Node resolver walks `MODDEF_PACKAGE_ROOTS` directories (same layout as
`moddef/stdlib`); browser resolver is fetch-based or a preloaded map. The
stdlib measurands catalog ships pre-bundled in `@moddef/core` so measurand
validation works offline in the browser.

### codec (spec §8–§15, mirrors go/codec 1:1)

```ts
type DecodedValue =
  | number            // scaled numerics, DECIMAL, floats
  | bigint            // U64/S64/acc64 pre-scale (unscaled or scale 1)
  | boolean | string
  | readonly string[]                    // FLAGS: names of set bits
  | Uint8Array                           // BYTES_RAW
  | Date                                 // DATETIME
  | { [field: string]: DecodedValue }    // bit/register fields
  | Unavailable                          // na_values hit: { meaning: string }

interface CodecContext { refs: Map<string, bigint> }  // scale_ref / selector_ref / count_ref

decodePoint(point: Point, regs: Uint16Array, ctx?: CodecContext): DecodedValue
encodePoint(point: Point, value: unknown, ctx?: CodecContext): Uint16Array
resolveContext(points, regsByPoint): CodecContext      // like codec.ResolveContext
```

Coverage parity with Go: endianness/word order, sign-magnitude, U24/U48/S48,
IEEE754 f32/f64, strings (charset/padding/termination), BCD, composed
mantissa/exponent, bit fields + register fields, flag sets, DATETIME
(epoch s/ms, packed BCD, split fields), na_values (pre-scale raw match →
`Unavailable`), static rational scale/offset + clamp, `scale_ref` POW10 &
MULTIPLY, `selector_ref` cases, write encoding (`encode ≠ decode`,
`prefix_high_byte`).

Precision policy: rational scaling computes in float64 (Go returns `*big.Rat`;
TS returns `number` and additionally exposes `decodePointRaw()` returning the
pre-scale integer plus the rational, for callers that need exactness — e.g.
billing-grade energy counters scaled from U64).

### transport.ts (spec §32.3, mirrors go/client.Transport)

```ts
interface Transport {
  readHolding(offset: number, quantity: number, opts?: TransportOpts): Promise<Uint16Array>
  readInput(offset: number, quantity: number, opts?: TransportOpts): Promise<Uint16Array>
  readCoils(offset: number, quantity: number, opts?: TransportOpts): Promise<boolean[]>
  readDiscrete(offset: number, quantity: number, opts?: TransportOpts): Promise<boolean[]>
  writeHolding(offset: number, values: Uint16Array, opts?: TransportOpts): Promise<void>
  writeCoil(offset: number, value: boolean, opts?: TransportOpts): Promise<void>
}
interface TransportOpts { signal?: AbortSignal; unitId?: number }
```

Offsets are 0-based wire offsets (§7.1). Single-register writes are the
adapter's choice (FC06 vs FC16) unless the point constrains function codes.

### errors.ts

`ModDefError` base +: `PointNotFoundError`, `MeasurandNotSupportedError`
(§26.3), `AmbiguousMeasurandError` (§26.4), `UnsupportedMappingError`,
`DecodeError`, `EncodeError`, `WriteConstraintError` (min/max/step/
allowed_values violations, carries the constraint), `WriteAccessError`,
`TransportError` (wraps adapter errors, carries Modbus exception code when
known). All carry structured fields, not just messages.

### device.ts — runtime facade (spec §32.4, mirrors go/client)

```ts
class Device {
  static create(doc, deviceId, transport): Device
  readPoint(id: string, opts?): Promise<DecodedValue>
  readPoints(ids: string[], opts?): Promise<Map<string, DecodedValue>>   // batches contiguous reads
  writePoint(id: string, value: unknown, opts?): Promise<void>           // validates write constraints
  readMeasurand(q: MeasurandQuery, opts?): Promise<DecodedValue>         // §26.1
  points(): PointInfo[]                                                  // metadata access (§32.1)
}
```

Behavior ported from `go/client/client.go`: SunSpec discovery (anchor walk for
`SunS`, model-chain scan, cached model base per block), automatic scale_ref /
selector_ref companion reads, measurand matching with wildcard qualifiers and
ambiguity errors, COIL/DISCRETE bit handling. Same declared limitation:
composed values decode via codec directly, not through the facade (keep the
Go comment parity so gaps close in lockstep).

## @moddef/codegen

Generator is a pure function over a (resolved) document → deterministic file
set; CLI wraps it (`moddef-ts gen -o src/generated devices/.../growatt-sph.moddef.yaml`).
Sorted iteration, no timestamps; snapshot-tested.

### Enum emission — the type-narrowing core

`enum` keyword is avoided; const objects give literal-type narrowing:

```ts
export const SystemWorkMode = {
  WAITING: 0, SELF_TEST: 1, RESERVED: 2, SYS_FAULT: 3, FLASH: 4,
  PV_BAT_ONLINE: 5, BAT_ONLINE: 6, PV_OFFLINE: 7, BAT_OFFLINE: 8,
} as const;
export type SystemWorkMode = (typeof SystemWorkMode)[keyof typeof SystemWorkMode]; // 0|1|...|8
export type SystemWorkModeName = keyof typeof SystemWorkMode;
export const systemWorkModeName: (v: SystemWorkMode) => SystemWorkModeName;
```

Decoded enum points are typed as the literal union, so `switch` narrowing and
exhaustiveness checks work. Flags points are typed as
`ReadonlyArray<'spi_enable' | 'auto_test_start' | …>`; register-field points
as exact object types (`{ hour: number; minute: number }`).

### Points catalog

`as const` metadata table (the TS analog of goclient's `PointMeta` registry,
superset: space, offset/model_relative_offset, length, storage/value type,
access, unit, scale, measurand tuple, na/write metadata) plus
`export type PointId = keyof typeof points`. Usable standalone without the
facade — parity with the Go/Python "catalog only" generators.

### Device class

One class per `DeviceProfile`, wrapping `@moddef/core`'s `Device`:

```ts
const dev = new GrowattSph(transport);
await dev.inverterStatus();          // Promise<InverterRunState>  (0|1|3)
await dev.gridFirstSlot1Start();     // Promise<{ hour: number; minute: number }>
await dev.safetyFunctionEnable();    // Promise<ReadonlyArray<'spi_enable' | …>>
await dev.setAcChargeEnable(EnableState.ENABLED);  // arg type = literal union
```

- One camelCase getter per readable point; `setX(value)` per writable point
  (typed by value_type; enum writes accept only the literal union; write
  constraints still validated at runtime).
- Return types derived from value_type: enum_ref → literal union, flags →
  readonly literal array, fields → exact object, DECIMAL/float → `number`,
  STRING → `string`, DATETIME → `Date`, BYTES_RAW → `Uint8Array`, points with
  na_values → `T | Unavailable`.
- Convenience measurand methods (§26.2) generated from the profile's actual
  measurand set with qualifiers narrowed to what exists, e.g. for growatt-sph
  `voltage(phase: 'L1_N' | 'L2_N' | 'L3_N' | 'L1_L2' | 'L2_L3' | 'L3_L1')`.
  Queries that are ambiguous at generation time get required qualifiers;
  unresolvable ambiguity falls back to the generic `readMeasurand` with a
  doc comment (§26.4).
- Naming: snake_case → camelCase; collisions get numeric suffixes (same
  seen-set policy as pyclient); original point_id always available via the
  catalog and `readPoint(id)`.

Generated code imports only `@moddef/core`.

## @moddef/transport-modbus-serial

Node-only wrapper around `modbus-serial`'s `ModbusRTU` client:

- Constructors for RTU (`connectRTUBuffered(path, {baudRate,…})`) and TCP
  (`connectTCP(host, {port})`); `unitId` fixed at construction or per-call.
- Maps Transport → `readHoldingRegisters` / `readInputRegisters` /
  `readCoils` / `readDiscreteInputs` / `writeRegisters` / `writeRegister` /
  `writeCoil`.
- **Serialization**: `modbus-serial` is not safe for concurrent requests — the
  adapter owns a promise queue (one in-flight request; FIFO), plus
  per-request timeout and `AbortSignal` support.
- Errors wrapped in `TransportError` with Modbus exception codes preserved.
- Honors the 125-register read limit and any device-specific max (e.g.
  SDM630's 40-parameter limit) via a configurable `maxReadWords`.

Browser story: `@moddef/core` and all generated code are browser-clean; Modbus
itself needs a bridge (raw TCP/serial is unavailable in browsers). The
`examples/browser-ws-bridge` example implements `Transport` over a WebSocket
to a tiny Node bridge. A `@moddef/transport-web-serial` (Web Serial API, RTU
framing in JS) is a documented follow-up, not v0.1.

## Testing & conformance (spec §33)

1. **Fixture equivalence** (`conformance/`): drive `moddef/fixtures/manifest.yaml`
   — YAML↔JSON↔binary triples must parse to deep-equal documents and
   re-serialize losslessly; `invalid/` docs with `schema_valid: false` must
   throw parse errors.
2. **Codec parity**: port `go/codec/{decode,roundtrip}_test.go` cases; add a
   small Go tool (`moddef gen-vectors`, or a test helper) that dumps
   JSON decode vectors {point, registers, expected} from the Go codec so both
   implementations consume one vector set (cross-language decode/encode tests).
3. **Generator goldens**: generate from the three golden fixtures and all 8
   `devices/` registry profiles (396-point growatt-sph is the stress test);
   snapshot outputs and run `tsc --noEmit` over them in CI.
4. **Facade tests**: mock Transport backed by register images of the golden
   docs; includes a SunSpec chain image to test discovery + scale_ref
   (fronius-gen24 profile is the real-world case).
5. **Browser smoke**: esbuild bundle of `@moddef/core` + a generated device
   with `platform=browser` and `external: []` must succeed (proves no Node
   builtins leak); optional vitest browser run.
6. **Adapter test**: `modbus-serial` against its own in-process TCP test
   server (the package ships `ServerTCP`) — round-trip a golden device image.

## Milestones

1. **Scaffold + document layer** — workspace, vendored schema, parse/serialize
   + format detection, fixture equivalence green.
2. **Codec** — decode first (all storage/value types), then encode; vector
   parity with Go.
3. **Runtime facade** — transport iface, errors, Device (incl. SunSpec
   discovery, refs, write constraints); mock-transport tests.
4. **Codegen** — enums → catalog → device class → measurand convenience; CLI;
   golden + typecheck tests.
5. **modbus-serial adapter + examples** — Node RTU/TCP example against
   growatt-sph / sdm630 profiles; browser WS-bridge example.
6. **CI + publish prep** — GitHub Actions (Node LTS matrix, schema-drift
   check, browser bundle smoke), README per package, `0.1.0` under the
   `@moddef` scope (tracking spec v0.4).

## Implementation deviations log (v0.1, as built)

- **npm workspaces instead of pnpm** (no pnpm on the build host; zero extra
  toolchain). **Plain `tsc` ESM output instead of tsup dual-format** — CJS
  publishing can be added later without API changes.
- **SunSpec `model_relative_offset` is ID-relative** (offset 0 = model ID
  register), matching the spec §7.3 example (canonical model 103 W=14) and
  the profiles in `devices/`. The Go client + stdlib sunspec package were
  data-relative (ID + 2), an off-by-two versus the spec example — **fixed
  upstream** (client.go, stdlib sunspec offsets, spec §7.3 now states the
  convention explicitly).
- **selector_ref cases (§10.5) are applied** in the TS codec, and — since the
  upstream fix — in the Go codec as well; both fall back to the point
  transform when the selector is unresolved or no case matches.
- **Writes are implemented in the facade** (`writePoint` with §11.4
  constraint validation); the Go facade is read-only so far.
- Measurand convenience methods are named `get<BaseQuantity>` (e.g.
  `getVoltage({phase})`) so they never collide with per-point getters
  (`voltageL1N()`).
- The vendored schema needed `.js` import extensions; **fixed upstream**
  (`buf.gen.yaml` now passes `import_extension=js`, and the checked-in
  `gen/ts` output was repatched). `sync-schema` keeps its idempotent sed as a
  belt-and-braces guard.
- Go-generated decode-vector interchange (cross-language codec parity file)
  is still a follow-up; current parity coverage is the mirrored unit vectors
  plus the byte-identical golden fixture round-trips.

## Decisions taken (defaults, flag if you disagree)

- **pnpm** workspaces; **tsup** dual ESM+CJS; ES2022 target.
- Vendored protobuf-es schema (synced from `moddef/gen/ts`) rather than a
  separate published `@moddef/schema` package — fewer moving parts pre-1.0.
- `const`-object enums (not `enum`) for narrowing + erasableSyntaxOnly
  compatibility.
- Scaled values are `number` (float64); exactness available via
  `decodePointRaw` (pre-scale integer + rational).
- TS generator lives here (idiomatic emission + typecheckable goldens), not in
  the Go CLI; the Go `moddef gen` grows `--lang ts` later only as a shim if
  ever needed.
