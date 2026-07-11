import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@moddef/core/node": r("./packages/core/src/node.ts"),
      "@moddef/core": r("./packages/core/src/index.ts"),
      "@moddef/codegen": r("./packages/codegen/src/index.ts"),
      "@moddef/transport-modbus-serial": r("./packages/transport-modbus-serial/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "conformance/**/*.test.ts"],
    testTimeout: 20000,
  },
});
