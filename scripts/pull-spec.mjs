#!/usr/bin/env node
/**
 * Refresh the pinned OpenAPI document, `openapi/talki-v1.yaml`.
 *
 * The API's own repository exports the document and commits it at
 * `api-cli/openapi/talki-v1.yaml`. With no argument this reads that file from
 * the sibling `talki-backend` checkout's `origin/main`, freshly fetched: the
 * contract production serves, whichever branch that checkout has out. Only
 * Talki's team has that checkout; anyone else passes a path or URL.
 *
 *     node scripts/pull-spec.mjs
 *     node scripts/pull-spec.mjs --ref origin/dev      # preview; never release from it
 *     node scripts/pull-spec.mjs ./talki-v1.yaml
 *     node scripts/pull-spec.mjs https://developers.talki.it/openapi.yaml
 *
 * `TALKI_BACKEND` names the backend checkout when it is not the sibling
 * directory. Then run `npm run generate`.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "openapi", "talki-v1.yaml");
const SPEC_IN_BACKEND = "api-cli/openapi/talki-v1.yaml";

const args = process.argv.slice(2);
const refAt = args.indexOf("--ref");
const ref = refAt === -1 ? "origin/main" : args[refAt + 1];
const source = args.find((arg, i) => !arg.startsWith("--") && i !== refAt + 1);

function git(backend, ...rest) {
  return execFileSync("git", ["-C", backend, ...rest], { encoding: "utf8" });
}

let text;
let origin;
if (source && /^https?:\/\//.test(source)) {
  const answer = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!answer.ok) throw new Error(`${source}: HTTP ${answer.status}`);
  text = await answer.text();
  origin = source;
} else if (source) {
  text = await readFile(source, "utf8");
  origin = source;
} else {
  const backend = resolve(process.env.TALKI_BACKEND ?? join(ROOT, "..", "talki-backend"));
  let rev = ref;
  if (rev.startsWith("origin/")) {
    // FETCH_HEAD, not the remote-tracking ref, which a narrowed clone may not update.
    git(backend, "fetch", "--quiet", "origin", rev.slice("origin/".length));
    rev = "FETCH_HEAD";
  }
  text = git(backend, "show", `${rev}:${SPEC_IN_BACKEND}`);
  origin = `talki-backend ${ref} (${git(backend, "rev-parse", "--short", rev).trim()})`;
}

const spec = parse(text);
if (!spec?.openapi || !spec?.paths || !spec?.info?.version) throw new Error(`${origin} is not an OpenAPI document`);
const before = await readFile(TARGET, "utf8").catch(() => "");
await writeFile(TARGET, text);
console.log(
  before === text
    ? `pull-spec: unchanged, from ${origin}.`
    : `pull-spec: wrote ${TARGET} (API ${spec.info.version}) from ${origin}. Now run npm run generate.`,
);
