// The hand-written layer: the client, its transport, the reading of answers
// and the errors, against a mocked `fetch`.

import { describe, expect, it } from "vitest";
import { retryAfterSeconds } from "../src/errors.js";
import {
  API_VERSION,
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  InvalidRequestError,
  PermissionDeniedError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
  Talki,
  TalkiError,
} from "../src/index.js";
import { neverSent } from "../src/transport.js";
import { APPOINTMENT, dropped, empty, envelope, hang, html, json, make, Recorder, refused } from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT = { id: "acc", business_name: "Studio" };

describe("the client itself", () => {
  it("takes exactly one credential", () => {
    const saved = process.env.TALKI_API_KEY;
    delete process.env.TALKI_API_KEY;
    try {
      expect(() => new Talki()).toThrow(TypeError);
      expect(() => new Talki({ apiKey: "talki_test_x", accessToken: "talki_at_x" })).toThrow(TypeError);
    } finally {
      if (saved !== undefined) process.env.TALKI_API_KEY = saved;
    }
  });

  it("sends the version it was generated from, and the key as a bearer", async () => {
    const seen = new Recorder(json(200, ACCOUNT));
    await make(seen).account.get();
    expect(seen.requests[0]?.headers.get("Talki-Version")).toBe(API_VERSION);
    expect(seen.requests[0]?.headers.get("Authorization")).toBe("Bearer talki_test_x");
  });

  it("sends no version when told, and an access token as a bearer", async () => {
    const seen = new Recorder(json(200, ACCOUNT));
    const client = new Talki({ accessToken: "talki_at_x", version: null, fetch: seen.fetch });
    await client.account.get();
    expect(seen.requests[0]?.headers.has("Talki-Version")).toBe(false);
    expect(seen.requests[0]?.headers.get("Authorization")).toBe("Bearer talki_at_x");
    expect(client.version).toBeNull();
  });

  it("never shows the credential", () => {
    const client = new Talki({ apiKey: "talki_test_secret" });
    expect(JSON.stringify(client)).not.toContain("talki_test_secret");
    expect(String(client)).not.toContain("talki_test_secret");
    expect(Object.values(client).join()).not.toContain("talki_test_secret");
  });

  it("refuses a bad timeout or retry count", () => {
    expect(() => new Talki({ apiKey: "k", timeout: 0 })).toThrow(RangeError);
    expect(() => new Talki({ apiKey: "k", maxRetries: -1 })).toThrow(RangeError);
    expect(() => new Talki({ apiKey: "k", maxRetries: 1.5 })).toThrow(RangeError);
  });
});

describe("idempotency keys", () => {
  it("gives a write without a key one, and a read none", async () => {
    const seen = new Recorder(json(201, {}), json(200, ACCOUNT));
    const client = make(seen);
    await client.appointments.create({ body: APPOINTMENT });
    await client.account.get();
    expect(seen.requests[0]?.headers.get("Idempotency-Key")).toMatch(UUID);
    expect(seen.requests[1]?.headers.has("Idempotency-Key")).toBe(false);
  });

  it("keeps a key given", async () => {
    const seen = new Recorder(json(201, {}));
    await make(seen).appointments.create({ body: APPOINTMENT, idempotencyKey: "mine" });
    expect(seen.requests[0]?.headers.get("Idempotency-Key")).toBe("mine");
  });

  it("sends none with autoIdempotency off", async () => {
    const seen = new Recorder(json(201, {}));
    await make(seen, { autoIdempotency: false }).appointments.create({ body: APPOINTMENT });
    expect(seen.requests[0]?.headers.has("Idempotency-Key")).toBe(false);
  });

  it("replaces a blank key and never trusts one", async () => {
    const seen = new Recorder(json(201, {}));
    await make(seen).appointments.create({ body: APPOINTMENT, idempotencyKey: "  " });
    expect(seen.requests[0]?.headers.get("Idempotency-Key")).toMatch(UUID);

    const unkeyed = new Recorder(empty(502), json(201, {}));
    const error = await make(unkeyed, { autoIdempotency: false })
      .appointments.create({ body: APPOINTMENT, idempotencyKey: "" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerError);
    expect(unkeyed.requests).toHaveLength(1);
    expect(unkeyed.requests[0]?.headers.has("Idempotency-Key")).toBe(false);
  });
});

describe("retries", () => {
  it.each([429, 500, 502, 503, 504])("retries a read answered %i", async (status) => {
    const seen = new Recorder(empty(status), json(200, ACCOUNT));
    const sleeps: number[] = [];
    expect(await make(seen, { sleeps }).account.get()).toEqual(ACCOUNT);
    expect(seen.requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0.25);
    expect(sleeps[0]).toBeLessThanOrEqual(0.5);
  });

  it("honours Retry-After", async () => {
    const seen = new Recorder(
      envelope(429, "rate_limit_error", "rate_limit_exceeded", { "Retry-After": "3" }),
      json(200, ACCOUNT),
    );
    const sleeps: number[] = [];
    await make(seen, { sleeps }).account.get();
    expect(sleeps).toEqual([3]);
  });

  it("hands a long Retry-After back", async () => {
    const seen = new Recorder(envelope(429, "rate_limit_error", "rate_limit_exceeded", { "Retry-After": "120" }));
    const error = await make(seen)
      .account.get()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(120);
    expect(seen.requests).toHaveLength(1);
  });

  it("retries a write with the same key and body", async () => {
    const seen = new Recorder(empty(503), json(201, {}));
    await make(seen).appointments.create({ body: APPOINTMENT });
    const [first, second] = seen.requests;
    expect(first?.headers.get("Idempotency-Key")).toBe(second?.headers.get("Idempotency-Key"));
    expect(first?.headers.get("Idempotency-Key")).toBeTruthy();
    expect(first?.body).toBe(second?.body);
  });

  it("never retries a write without a key", async () => {
    const seen = new Recorder(empty(503), json(201, {}));
    await expect(make(seen, { autoIdempotency: false }).appointments.create({ body: APPOINTMENT })).rejects.toThrow(
      ServerError,
    );
    expect(seen.requests).toHaveLength(1);
  });

  it("stops at maxRetries", async () => {
    const seen = new Recorder(envelope(503, "api_error", "service_unavailable"));
    await expect(make(seen, { maxRetries: 3 }).account.get()).rejects.toThrow(ServerError);
    expect(seen.requests).toHaveLength(4);
  });

  it("never retries with maxRetries 0", async () => {
    const seen = new Recorder(empty(503), json(200, ACCOUNT));
    await expect(make(seen, { maxRetries: 0 }).account.get()).rejects.toThrow(ServerError);
    expect(seen.requests).toHaveLength(1);
  });

  it("retries request_in_progress, and no other conflict", async () => {
    const seen = new Recorder(envelope(409, "conflict", "request_in_progress"), json(201, {}));
    await make(seen).appointments.create({ body: APPOINTMENT });
    expect(seen.requests).toHaveLength(2);

    const other = new Recorder(envelope(409, "conflict", "slot_unavailable"), json(201, {}));
    const error = await make(other)
      .appointments.create({ body: APPOINTMENT })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("slot_unavailable");
    expect(other.requests).toHaveLength(1);
  });

  it("retries a connection never made, even for a write without a key", async () => {
    const seen = new Recorder(refused(), json(201, {}));
    await make(seen, { autoIdempotency: false }).appointments.create({ body: APPOINTMENT });
    expect(seen.requests).toHaveLength(2);
  });

  it("retries a connection broken after sending for a read only", async () => {
    const seen = new Recorder(dropped(), json(200, ACCOUNT));
    await make(seen).account.get();
    expect(seen.requests).toHaveLength(2);

    const keyed = new Recorder(dropped(), json(201, {}));
    const error = await make(keyed)
      .appointments.create({ body: APPOINTMENT, idempotencyKey: "k1" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).sent).toBe(true);
    // The key sent is on the error, to retry with once the outcome is known.
    expect((error as ConnectionError).idempotencyKey).toBe("k1");
    expect(keyed.requests).toHaveLength(1);
  });

  it("retries a read that timed out, and never a write", async () => {
    const slow = new Recorder(hang, json(200, ACCOUNT));
    expect(await make(slow, { timeout: 20 }).account.get()).toEqual(ACCOUNT);
    expect(slow.requests).toHaveLength(2);

    const write = new Recorder(hang);
    const error = await make(write, { timeout: 20 })
      .appointments.create({ body: APPOINTMENT })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as RequestTimeoutError).idempotencyKey).toMatch(UUID);
    expect(write.requests).toHaveLength(1);
  });

  it("aborts at once on the caller's signal, without retrying", async () => {
    const controller = new AbortController();
    const seen = new Recorder(() => {
      controller.abort(new Error("stop"));
      return empty(503);
    });
    await expect(make(seen).account.get({ signal: controller.signal })).rejects.toThrow("stop");
    expect(seen.requests).toHaveLength(1);
  });

  it("does not retry a write the API failed itself", async () => {
    for (const answer of [
      envelope(500, "api_error", "internal_error"),
      envelope(503, "api_error", "service_unavailable"),
    ]) {
      const seen = new Recorder(answer, json(201, {}));
      await expect(make(seen).appointments.create({ body: APPOINTMENT })).rejects.toThrow(ServerError);
      expect(seen.requests).toHaveLength(1);
    }
  });

  it("retries a write a gateway failed", async () => {
    const seen = new Recorder(html(502, "<html>Bad gateway</html>"), json(201, {}));
    await make(seen).appointments.create({ body: APPOINTMENT });
    expect(seen.requests).toHaveLength(2);
  });

  it("retries a 429 even for a write without a key", async () => {
    const seen = new Recorder(envelope(429, "rate_limit_error", "rate_limit_exceeded"), json(201, {}));
    await make(seen, { autoIdempotency: false }).appointments.create({ body: APPOINTMENT });
    expect(seen.requests).toHaveLength(2);
  });

  it("reads Retry-After as a date", async () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const seen = new Recorder(empty(503, { "Retry-After": when }), json(200, ACCOUNT));
    const sleeps: number[] = [];
    await make(seen, { sleeps }).account.get();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(25);
    expect(sleeps[0]).toBeLessThanOrEqual(31);
  });

  it("reads a date ending -0000 as UTC", () => {
    const later = new Date(Date.now() + 30_000).toUTCString().replace("GMT", "-0000");
    const seconds = retryAfterSeconds(new Headers({ "Retry-After": later })) ?? 0;
    expect(seconds).toBeGreaterThanOrEqual(25);
    expect(seconds).toBeLessThanOrEqual(31);
    expect(retryAfterSeconds(new Headers({ "Retry-After": "soon" }))).toBeNull();
    expect(retryAfterSeconds(new Headers({ "Retry-After": "0x10" }))).toBeNull();
    expect(retryAfterSeconds(new Headers({ "Retry-After": " 2.5 " }))).toBe(2.5);
    expect(retryAfterSeconds(new Headers())).toBeNull();
  });

  it("retries the maintenance page for a write, and reads it as no envelope", async () => {
    const maintenance = json(503, { error: "maintenance", message: "back soon" });
    const seen = new Recorder(maintenance, json(201, {}));
    await make(seen).appointments.create({ body: APPOINTMENT });
    expect(seen.requests).toHaveLength(2);

    const down = new Recorder(maintenance);
    const error = await make(down, { maxRetries: 0 })
      .account.startForwardingCheck()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).code).toBeNull();
  });

  it("does not follow a redirect", async () => {
    let init: RequestInit | undefined;
    const client = new Talki({
      apiKey: "k",
      fetch: async (_input, given) => {
        init = given;
        return empty(204);
      },
    });
    await client.contacts.delete("c");
    expect(init?.redirect).toBe("manual");
  });

  it("tells a connection never made from one that may have carried the request", () => {
    expect(neverSent(refused())).toBe(true);
    expect(neverSent(dropped())).toBe(false);
    // Node, when every address of a host refuses.
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })]), {});
    expect(neverSent(new TypeError("fetch failed", { cause: aggregate }))).toBe(true);
    // Bun and Deno.
    expect(neverSent(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }))).toBe(true);
    expect(neverSent(new TypeError("fetch failed", { cause: new Error("client error (Connect): dns error: x") }))).toBe(
      true,
    );
    expect(neverSent(new Error("anything else"))).toBe(false);
  });
});

describe("answers and errors", () => {
  it.each([
    [400, "invalid_request", InvalidRequestError],
    [401, "authentication_error", AuthenticationError],
    [403, "permission_error", PermissionDeniedError],
    [409, "conflict", ConflictError],
    [429, "rate_limit_error", RateLimitError],
    [500, "api_error", ServerError],
    [403, "type_added_later", ApiError],
  ])("throws the class of the error type (%i %s)", async (status, type, Class) => {
    const seen = new Recorder(envelope(status, type, "some_code"));
    const error = await make(seen, { maxRetries: 0 })
      .account.get()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TalkiError);
    expect((error as ApiError).constructor).toBe(Class);
    const { status: got, type: kind, code, requestId } = error as ApiError;
    expect([got, kind, code, requestId]).toEqual([status, type, "some_code", "req_1"]);
    expect((error as ApiError).message).toBe(`HTTP ${status} some_code: m (request req_1)`);
    expect((error as ApiError).apiMessage).toBe("m");
    expect((error as ApiError).name).toBe(Class.name);
  });

  it("reads an error without an envelope by its status", async () => {
    const seen = new Recorder(html(502, "<html>Bad gateway</html>"));
    const error = (await make(seen, { maxRetries: 0 })
      .account.get()
      .catch((caught: unknown) => caught)) as ServerError;
    expect(error).toBeInstanceOf(ServerError);
    expect(error.code).toBeNull();
    expect(error.apiMessage).toContain("Bad gateway");
  });

  it.each([
    [400, InvalidRequestError],
    [401, AuthenticationError],
    [403, PermissionDeniedError],
    [404, ApiError],
    [409, ConflictError],
    [429, RateLimitError],
    [500, ServerError],
  ])("classes a bare %i by its status", async (status, Class) => {
    const error = await make(new Recorder(empty(status)), { maxRetries: 0 })
      .account.get()
      .catch((caught: unknown) => caught);
    expect((error as ApiError).constructor).toBe(Class);
  });

  it("returns undefined for no content", async () => {
    expect(await make(new Recorder(empty(204))).contacts.delete("c")).toBeUndefined();
  });

  it("refuses a success it cannot read", async () => {
    const error = (await make(new Recorder(json(202, { unexpected: true })))
      .account.get()
      .catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(202);

    const notJson = (await make(new Recorder(html(200, "<html>")))
      .account.get()
      .catch((caught: unknown) => caught)) as ApiError;
    expect(notJson.status).toBe(200);
  });

  it("returns the model", async () => {
    const seen = new Recorder(json(200, { object: "list", data: [], has_more: false, next_cursor: null }));
    expect((await make(seen).tags.list()).data).toEqual([]);
  });

  it("reads a gzip-free 409 for its code and still throws it whole", async () => {
    const seen = new Recorder(envelope(409, "conflict", "slot_unavailable"));
    const error = (await make(seen)
      .appointments.create({ body: APPOINTMENT })
      .catch((caught: unknown) => caught)) as ConflictError;
    expect(error.code).toBe("slot_unavailable");
    expect(JSON.parse(error.body).error.code).toBe("slot_unavailable");
    expect(error.headers.get("content-type")).toBe("application/json");
  });
});
