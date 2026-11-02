// The built ES modules load on their own, through the package's exports.
import assert from "node:assert/strict";
import { API_VERSION, Page, Talki, toFile, VERSION } from "@hubtec/talki";
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

// On this runtime's own fetch types: an upload goes out as
// multipart/form-data, and a download comes back as a File it names.
const files = new Talki({
  apiKey: "talki_test_smoke",
  maxRetries: 0,
  fetch: async (url, init) => {
    if (init.method === "GET") {
      return new Response("smoke", {
        headers: { "content-type": "text/plain", "content-disposition": "attachment; filename*=UTF-8''notes.txt" },
      });
    }
    const sent = new Request(url, { method: init.method, body: init.body });
    assert.match(sent.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
    const file = (await sent.formData()).get("file");
    assert.equal(file.name, "notes.txt");
    assert.equal(await file.text(), "smoke");
    return new Response(JSON.stringify({ id: "d1" }), { status: 202, headers: { "content-type": "application/json" } });
  },
});
assert.equal((await files.documents.create({ form: { file: await toFile("smoke", "notes.txt") } })).id, "d1");
const download = await files.documents.getFile("d1");
assert.equal(download.name, "notes.txt");
assert.equal(await download.text(), "smoke");
assert.equal((await createPkce()).verifier.length, 64);
assert.equal(typeof verifySignature, "function");
console.log(`smoke (esm): @hubtec/talki ${VERSION}, API ${API_VERSION}`);
