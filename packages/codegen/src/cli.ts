#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * moddef-ts CLI.
 *
 *   moddef-ts gen [-o <dir>] <file.moddef.{yaml,json,}> [...]
 *
 * Generates one TypeScript module per document into the output directory
 * (default: current directory).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDocument } from "@moddef/core/node";
import { generate } from "./generate.js";

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
  if (cmd !== "gen") {
    console.error("usage: moddef-ts gen [-o <dir>] <file.moddef.yaml> [...]");
    return 2;
  }
  let outDir = ".";
  const files: string[] = [];
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "-o" || a === "--out") {
      const v = args.shift();
      if (!v) {
        console.error("missing value for -o");
        return 2;
      }
      outDir = v;
    } else {
      files.push(a);
    }
  }
  if (files.length === 0) {
    console.error("no input files");
    return 2;
  }
  await mkdir(outDir, { recursive: true });
  for (const f of files) {
    const doc = await loadDocument(f);
    for (const out of generate(doc)) {
      const path = join(outDir, out.path);
      await writeFile(path, out.content, "utf8");
      console.error(`wrote ${path}`);
    }
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
