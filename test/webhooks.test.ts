// Webhook signatures, checked against a reference signer in the documented
// format: `t=<unix seconds>`, then one `v1=<hex HMAC-SHA256 of "<t>.<body>">`
// per secret, the previous secret's first while a rotation overlaps.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constructEvent,
  SIGNATURE_HEADER,
  SignatureVerificationError,
  signatureOf,
  verifySignature,
} from "../src/webhooks.js";

const NOW = 1_790_000_000;
const EVENT = { id: "evt_1", type: "call.ended", livemode: false, data: { object: { caller: "Niccolò Bianchi" } } };
// As the server writes it: compact, UTF-8, non-ASCII kept.
const BODY = new TextEncoder().encode(JSON.stringify(EVENT));

function v1(secret: string | Uint8Array, at: number, body: Uint8Array): string {
  return createHmac("sha256", secret).update(`${at}.`).update(body).digest("hex");
}

function signed(body: Uint8Array, secret: string, previous?: string, at = NOW): string {
  const parts = [`t=${at}`];
  if (previous) parts.push(`v1=${v1(previous, at, body)}`);
  parts.push(`v1=${v1(secret, at, body)}`);
  return parts.join(",");
}

const GOOD = signed(BODY, "whsec_current");
const V1 = GOOD.split("v1=")[1] ?? "";

describe("webhook signatures", () => {
  it("verify a known vector", async () => {
    // Fixed bytes, secret and time: pins the format independently of the signer above.
    const header = `t=1790000000,v1=${createHmac("sha256", "whsec_vector").update("1790000000.{}").digest("hex")}`;
    await verifySignature("{}", header, "whsec_vector", { now: NOW });
  });

  it("find the header whatever its case", async () => {
    for (const headers of [{ [SIGNATURE_HEADER]: GOOD }, { [SIGNATURE_HEADER.toLowerCase()]: GOOD }]) {
      expect(await constructEvent(BODY, signatureOf(headers), "whsec_current", { now: NOW })).toEqual(EVENT);
    }
    expect(signatureOf(new Headers({ "x-talki-signature": GOOD }))).toBe(GOOD);
    expect(signatureOf({ "x-talki-signature": [GOOD, "other"] })).toBe(GOOD);
    expect(signatureOf({ "Content-Type": "application/json" })).toBeNull();
  });

  it("verify a delivery as bytes, as an ArrayBuffer and as its text", async () => {
    await verifySignature(BODY, GOOD, "whsec_current", { now: NOW + 10 });
    await verifySignature(BODY.slice().buffer, GOOD, "whsec_current", { now: NOW });
    expect(await constructEvent(new TextDecoder().decode(BODY), GOOD, "whsec_current", { now: NOW })).toEqual(EVENT);
  });

  it("verify with either secret during a rotation", async () => {
    const header = signed(BODY, "whsec_new", "whsec_old");
    await verifySignature(BODY, header, "whsec_new", { now: NOW });
    await verifySignature(BODY, header, "whsec_old", { now: NOW });
    await verifySignature(BODY, header, ["whsec_unrelated", "whsec_new"], { now: NOW });
  });

  it.each([
    ["no header", BODY, null, "whsec_current", NOW],
    ["malformed", BODY, "garbage", "whsec_current", NOW],
    ["bad timestamp", BODY, `t=abc,v1=${V1}`, "whsec_current", NOW],
    ["wrong secret", BODY, GOOD, "whsec_other", NOW],
    // Re-serialised with ASCII escapes: other bytes, so another signature.
    [
      "re-serialised body",
      new TextEncoder().encode(JSON.stringify(EVENT).replace("ò", "\\u00f2")),
      GOOD,
      "whsec_current",
      NOW,
    ],
    ["too old", BODY, GOOD, "whsec_current", NOW + 301],
    ["from the future", BODY, GOOD, "whsec_current", NOW - 301],
    ["non-ASCII v1", BODY, `t=${NOW},v1=é`, "whsec_current", NOW],
    ["empty v1", BODY, `t=${NOW},v1=`, "whsec_current", NOW],
    ["uppercase names", BODY, `T=${NOW},V1=${V1}`, "whsec_current", NOW],
    // A second t: the last one is the one checked.
    ["injected t", BODY, `${GOOD},t=${NOW + 1}`, "whsec_current", NOW],
    ["huge t", BODY, `t=${"9".repeat(400)},v1=${V1}`, "whsec_current", NOW],
  ])("refuse %s", async (_name, body, header, secret, now) => {
    await expect(verifySignature(body, header, secret, { now })).rejects.toThrow(SignatureVerificationError);
  });

  it("take a missing secret as a programming error", async () => {
    await expect(verifySignature(BODY, GOOD, "", { now: NOW })).rejects.toThrow(TypeError);
    await expect(verifySignature(BODY, GOOD, [], { now: NOW })).rejects.toThrow(TypeError);
  });

  it("take a parsed body as a programming error", async () => {
    await expect(verifySignature(EVENT as never, GOOD, "whsec_current", { now: NOW })).rejects.toThrow(TypeError);
  });

  it("tolerate odd but valid header shapes", async () => {
    await verifySignature(BODY, ` t=${NOW} , v1=nothex , v1=${V1} `, "whsec_current", { now: NOW });
    await verifySignature(BODY, `t=${NOW},v1=,v1=${V1}`, "whsec_current", { now: NOW });
    await verifySignature(BODY, GOOD, new TextEncoder().encode("whsec_current"), { now: NOW + 300 });
    await verifySignature(BODY, GOOD, "whsec_current", { now: NOW, tolerance: 0 });
  });

  it("refuse a signed body that is not an event", async () => {
    for (const text of ["[1, 2]", "not json", "null"]) {
      const body = new TextEncoder().encode(text);
      await expect(constructEvent(body, signed(body, "whsec_current"), "whsec_current", { now: NOW })).rejects.toThrow(
        SignatureVerificationError,
      );
    }
  });

  it("take a text secret as its UTF-8, and bytes as the key as given", async () => {
    const key = "whsec_é";
    await verifySignature(BODY, signed(BODY, key), new TextEncoder().encode(key), { now: NOW });
    await verifySignature(BODY, signed(BODY, key), key, { now: NOW });
  });

  it("check against now by default", async () => {
    const at = Math.floor(Date.now() / 1000);
    await verifySignature(BODY, signed(BODY, "whsec_current", undefined, at), "whsec_current");
  });
});
