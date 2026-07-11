# @moddef/codegen

Generates standalone, fully typed TypeScript clients from ModDef documents
(spec §31/§32.4). Emits per document: const-object enums with literal-union
types, an `as const` point catalog, and one class per device profile whose
getters/setters carry narrowed types (enums, flag names, packed register
fields) plus §26.2 measurand convenience methods.

```bash
moddef-ts gen -o src/generated device.moddef.yaml
```

Generated modules depend only on `@moddef/core`. Output is deterministic and
`tsc --strict`-clean (enforced by tests against the blessed device registry).
