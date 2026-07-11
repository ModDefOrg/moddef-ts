/**
 * Browser bundle smoke test: bundle @moddef/core + a generated device module
 * + the WebSocket transport example for the browser platform with NO
 * externals. esbuild fails the build if any Node builtin leaks into the
 * browser-safe path.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const entry = `
import { parseDocument, Device, Unavailable, schema } from "@moddef/core";
import { WsTransport } from "${join(root, "examples/browser-ws-bridge/ws-transport.ts").replaceAll("\\", "/")}";
import * as gen from "${join(root, "test-output/smoke/eastron-sdm630.ts").replaceAll("\\", "/")}";
console.log(typeof parseDocument, typeof Device, typeof Unavailable, typeof schema, typeof WsTransport, Object.keys(gen).length);
`;

const result = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts" },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  logLevel: "silent",
  outdir: join(root, "test-output"),
});

const bytes = result.outputFiles.reduce((n, f) => n + f.contents.length, 0);
console.log(`browser bundle OK (${(bytes / 1024).toFixed(0)} KiB, no Node builtins)`);
