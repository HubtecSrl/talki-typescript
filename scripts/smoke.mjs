// The built ES modules load on their own, through the package's exports.
import assert from "node:assert/strict";
import { API_VERSION, Page, Talki, VERSION } from "@hubtec/talki";
import { createPkce } from "@hubtec/talki/oauth";
import { verifySignature } from "@hubtec/talki/webhooks";

const seen = [];
const talki = new Talki({
  apiKey: "talki_test_smoke",
  maxRetries: 0,
  fetch: async (url, init) => {
    seen.push([url, init.headers.get("Talki-Version")]);
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false, next_cursor: null }), {
      headers: { "content-type": "application/json" },
    });
  },
});
const page = await talki.calls.list({ limit: 1 });
assert.ok(page instanceof Page);
assert.deepEqual(seen, [["https://api.talki.it/v1/calls?limit=1", API_VERSION]]);
assert.equal((await createPkce()).verifier.length, 64);
assert.equal(typeof verifySignature, "function");
console.log(`smoke (esm): @hubtec/talki ${VERSION}, API ${API_VERSION}`);
