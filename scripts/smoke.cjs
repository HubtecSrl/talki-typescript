// The built CommonJS loads on its own, through the package's exports.
const assert = require("node:assert/strict");
const { API_VERSION, Talki, VERSION } = require("@hubtec/talki");
const { OAuthApp } = require("@hubtec/talki/oauth");
const { signatureOf } = require("@hubtec/talki/webhooks");

const talki = new Talki({ apiKey: "talki_test_smoke" });
assert.equal(typeof talki.calls.list, "function");
assert.equal(new OAuthApp("id", "secret").tokenUrl, "https://api.talki.it/oauth/token");
assert.equal(signatureOf({ "x-talki-signature": "t=1" }), "t=1");
console.log(`smoke (cjs): @hubtec/talki ${VERSION}, API ${API_VERSION}`);
