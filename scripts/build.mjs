#!/usr/bin/env node
/**
 * Build `dist/`: ES modules in `dist/esm`, CommonJS in `dist/cjs`, each with
 * its `.d.ts`. A `package.json` in each says which kind its `.js` files are.
 */

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

function compile(outDir, extra) {
  execFileSync(process.execPath, [tsc, "-p", join(ROOT, "tsconfig.build.json"), "--outDir", outDir, ...extra], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

await rm(join(ROOT, "dist"), { recursive: true, force: true });

const esm = join(ROOT, "dist", "esm");
compile(esm, []);
await writeFile(join(esm, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);

const cjs = join(ROOT, "dist", "cjs");
compile(cjs, ["--module", "CommonJS", "--moduleResolution", "Node10", "--verbatimModuleSyntax", "false"]);
await mkdir(cjs, { recursive: true });
await writeFile(join(cjs, "package.json"), `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);

console.log("build: wrote dist/esm and dist/cjs.");
