/**
 * Check that a webhook or app event came from Talki, before trusting it.
 *
 *     import { constructEvent, signatureOf, SignatureVerificationError } from "@hubtec/talki/webhooks";
 *
 *     export default {
 *       async fetch(request: Request, env: Env) {
 *         const body = new Uint8Array(await request.arrayBuffer());
 *         try {
 *           const event = await constructEvent(body, signatureOf(request.headers), env.TALKI_WEBHOOK_SECRET);
 *           await handle(event.type, event.data);
 *         } catch (error) {
 *           if (error instanceof SignatureVerificationError) return new Response(null, { status: 400 });
 *           throw error;
 *         }
 *         return new Response(null, { status: 200 });
 *       },
 *     };
 *
 * Pass the body as received, before any JSON parsing: the signature is over
 * those exact bytes, and a re-serialised body differs. While a secret is
 * rotated with an overlap the header signs with both, so either one verifies;
 * pass an array when you hold more than one.
 *
 * It uses WebCrypto only, so it runs on Node, Bun, Deno and edge runtimes.
 */

import { TalkiError } from "./errors.js";

export const SIGNATURE_HEADER = "X-Talki-Signature";
export const EVENT_HEADER = "X-Talki-Event";
export const DELIVERY_HEADER = "X-Talki-Delivery";
/** How far, in seconds, a signed timestamp may be from now before the delivery is refused as a possible replay. */
export const TOLERANCE_SECONDS = 300;

/** The delivery is not provably from Talki: answer it 400 and ignore it. */
export class SignatureVerificationError extends TalkiError {
  override name = "SignatureVerificationError";
}

/** A secret as text (its UTF-8 is the key, as the server signs) or as the key's bytes. */
export type Secret = string | Uint8Array;

/** The body as received: its bytes, or its text decoded as UTF-8 without any change. */
export type Payload = Uint8Array | ArrayBuffer | string;

export interface VerifyOptions {
  /** Seconds a signature may be from now. Defaults to `TOLERANCE_SECONDS`. */
  tolerance?: number;
  /** The time to check against, in seconds since the epoch. Defaults to now. */
  now?: number;
}

/** An event as delivered: `id`, `type`, `created_at`, `livemode`, `data`, … */
export interface WebhookEvent {
  id: string;
  type: string;
  [field: string]: unknown;
}

type HeaderSource = Headers | { get(name: string): string | null } | Record<string, string | string[] | undefined>;

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/**
 * `X-Talki-Signature` from a request's headers, whatever their case: a
 * `Headers`, or a plain object as Node's `IncomingMessage.headers` or a
 * gateway's event holds them.
 */
export function signatureOf(headers: HeaderSource): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(SIGNATURE_HEADER);
  }
  const wanted = SIGNATURE_HEADER.toLowerCase();
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (name.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

function bytesOf(payload: Payload): Uint8Array {
  if (typeof payload === "string") return encoder.encode(payload);
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  throw new TypeError("payload must be the body as received (bytes or text), not a parsed or re-serialised object.");
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function keyBytes(secret: Secret): Uint8Array<ArrayBuffer> {
  return typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret);
}

/**
 * Throw `SignatureVerificationError` unless ``header`` (`X-Talki-Signature`,
 * `t=<unix seconds>,v1=<hex>[,v1=…]`) signs ``payload`` with ``secret`` (or
 * one of several) within `tolerance` seconds of now.
 *
 * Any `v1` may match: during a rotation the header carries one per secret.
 */
export async function verifySignature(
  payload: Payload,
  header: string | null | undefined,
  secret: Secret | readonly Secret[],
  options: VerifyOptions = {},
): Promise<void> {
  const body = bytesOf(payload);
  if (!header) throw new SignatureVerificationError(`No ${SIGNATURE_HEADER} header.`);
  const given: readonly Secret[] = typeof secret === "string" || secret instanceof Uint8Array ? [secret] : secret;
  if (!Array.isArray(given) || given.length === 0 || given.some((each) => each.length === 0)) {
    throw new TypeError("A signing secret is required.");
  }

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const at = trimmed.indexOf("=");
    const name = at === -1 ? trimmed : trimmed.slice(0, at);
    const value = at === -1 ? "" : trimmed.slice(at + 1);
    if (name === "t") {
      timestamp = value;
    } else if (name === "v1" && HEX_DIGEST.test(value)) {
      // Only what could be an HMAC: anything else is no match, never a crash.
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) {
    throw new SignatureVerificationError(`Malformed ${SIGNATURE_HEADER} header.`);
  }
  if (!/^[+-]?\d+$/.test(timestamp.trim())) {
    throw new SignatureVerificationError("The signature's timestamp is not an integer.");
  }

  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);

  let matched = false;
  for (const each of given) {
    const key = await crypto.subtle.importKey("raw", keyBytes(each), { name: "HMAC", hash: "SHA-256" }, false, [
      "verify",
    ]);
    for (const signature of signatures) {
      // `verify` compares in constant time.
      if (await crypto.subtle.verify("HMAC", key, hexBytes(signature), signed)) matched = true;
    }
  }
  if (!matched) throw new SignatureVerificationError("The signature does not match.");

  // Checked after the HMAC, so a forged header cannot be told from a stale
  // one by how fast it is refused.
  const now = Math.floor(options.now ?? Date.now() / 1000);
  const age = Math.abs(now - Number(timestamp));
  const tolerance = options.tolerance ?? TOLERANCE_SECONDS;
  if (!(age <= tolerance)) {
    const shown = Number.isFinite(age) ? `${age} s` : "too far";
    throw new SignatureVerificationError(`The signature is ${shown} from now; refused as a possible replay.`);
  }
}

/**
 * The event, once `verifySignature` passes: the envelope as an object
 * (`id`, `type`, `created_at`, `livemode`, `data`, …).
 */
export async function constructEvent(
  payload: Payload,
  header: string | null | undefined,
  secret: Secret | readonly Secret[],
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  await verifySignature(payload, header, secret, options);
  let event: unknown;
  try {
    event = JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(bytesOf(payload)));
  } catch {
    throw new SignatureVerificationError("The signed body is not JSON.");
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new SignatureVerificationError("The signed body is not an event object.");
  }
  return event as WebhookEvent;
}
