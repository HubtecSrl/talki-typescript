// The resource methods (`talki.calls.list()`, …) generated per tag, and the
// pages a list returns, against a mocked `fetch`.

import { describe, expect, expectTypeOf, it } from "vitest";
import { OPERATIONS, SURFACE } from "../src/generated/resources.js";
import {
  type Call,
  ConflictError,
  type Contact,
  InvalidRequestError,
  Page,
  PagePromise,
  PaginationError,
  position,
  type RawResponse,
  ServerError,
  Talki,
} from "../src/index.js";
import { empty, envelope, json, make, Recorder, type Seen } from "./helpers.js";

// The public surface: the Python SDK's `METHODS`, camelCased. A method
// renamed or dropped by a regeneration (a new operation can take a name
// another one had) fails here instead of in a caller's code: change it with a
// changelog line, as a breaking change.
const METHODS: Record<string, string[]> = {
  account: ["completeOnboarding", "get", "getForwardingCheck", "startForwardingCheck", "update"],
  appointments: ["cancel", "create", "get", "list", "reschedule", "restore"],
  availability: ["get"],
  callerRules: ["create", "delete", "list", "listBlockedCallAttempts", "update"],
  calls: [
    "count",
    "countRefused",
    "delete",
    "exportCall",
    "exportCalls",
    "get",
    "getRefusedSummary",
    "getStats",
    "getTranscript",
    "list",
    "listRefused",
    "markAllRead",
    "update",
  ],
  closures: ["create", "delete", "list", "update"],
  contacts: ["delete", "get", "list", "upsert"],
  locations: ["list"],
  pendingContacts: ["approve", "discard", "list"],
  resources: ["create", "delete", "get", "list", "update"],
  sandbox: ["createCall", "listScenarios", "reset"],
  services: ["create", "delete", "get", "list", "update"],
  tags: ["create", "delete", "list", "tagContact", "untagContact", "update"],
  unresolvedRequests: ["get", "list", "teach", "update"],
  usage: ["get", "getHistory"],
  voices: ["getPreview", "list"],
  workingHours: ["get", "replace"],
};

const TAG = {
  id: "00000000-0000-0000-0000-0000000000aa",
  name: "VIP",
  color: "#ff0000",
  contact_ids: [],
  created_at: "2026-10-01T08:00:00+00:00",
};

function contact(n: number) {
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    phone_number: `+3934800000${String(n).padStart(2, "0")}`,
    first_name: null,
    last_name: null,
    display_name: null,
    notes: null,
    last_call_at: null,
    call_count: 0,
    created_at: "2026-10-01T08:00:00+00:00",
    updated_at: "2026-10-01T08:00:00+00:00",
  };
}

function contacts(numbers: number[], hasMore: boolean, nextCursor: string | null): Response {
  return json(200, { object: "list", data: numbers.map(contact), has_more: hasMore, next_cursor: nextCursor });
}

/** Answers by path and `cursor`, and keeps every request. */
class Server {
  readonly recorder: Recorder;

  constructor(answers: Record<string, () => Response>) {
    this.recorder = new Recorder((seen: Seen) => {
      const cursor = seen.url.searchParams.get("cursor");
      const answer = answers[`${seen.url.pathname} ${cursor ?? ""}`.trim()];
      if (!answer) throw new Error(`no answer for ${seen.url}`);
      return answer();
    });
  }

  get cursors(): Array<string | null> {
    return this.recorder.requests.map((request) => request.url.searchParams.get("cursor"));
  }

  get requests(): Seen[] {
    return this.recorder.requests;
  }

  client(): Talki {
    return make(this.recorder, { maxRetries: 0 });
  }
}

function threePages(): Server {
  return new Server({
    "/v1/contacts": () => contacts([1, 2], true, "c1"),
    "/v1/contacts c1": () => contacts([3], true, "c2"),
    "/v1/contacts c2": () => contacts([4], false, "c3"),
  });
}

const tail = (row: Contact) => row.phone_number.slice(-2);

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const each of iterable) out.push(each);
  return out;
}

function methodsOf(resource: object): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(resource))
    .filter((name) => name !== "constructor")
    .sort();
}

describe("the surface", () => {
  it("has every tag as a resource with the methods it had", () => {
    const client = new Talki({ apiKey: "k" });
    const actual = Object.fromEntries(
      Object.keys(METHODS).map((tag) => [tag, methodsOf((client as unknown as Record<string, object>)[tag] ?? {})]),
    );
    expect(actual).toEqual(METHODS);
    expect(Object.fromEntries(Object.entries(SURFACE).map(([tag, names]) => [tag, [...names].sort()]))).toEqual(
      METHODS,
    );
  });

  it("has the same methods with the raw response", () => {
    const client = new Talki({ apiKey: "k" }) as unknown as Record<string, { withRawResponse: object }>;
    for (const [tag, names] of Object.entries(METHODS)) {
      const resource = client[tag];
      expect(resource && methodsOf(resource.withRawResponse)).toEqual(names);
      // Built once per resource, and once per client.
      expect(resource?.withRawResponse).toBe(client[tag]?.withRawResponse);
      expect(resource).toBe(client[tag]);
    }
  });

  it("reaches every operation, and a method pages exactly when it takes a cursor", async () => {
    const reached = new Set<string>();
    const recorder = new Recorder((seen: Seen) => {
      reached.add(`${seen.method} ${seen.url.pathname}`);
      return json(200, { data: [], has_more: false, next_cursor: null });
    });
    type Methods = Record<string, (...args: unknown[]) => unknown>;
    const client = make(recorder, { maxRetries: 0 }) as unknown as Record<
      string,
      Methods & { withRawResponse: Methods }
    >;
    const operations = OPERATIONS as Record<string, { method: string; path: string; query: readonly string[] }>;
    const paging = new Set<string>();
    for (const [tag, names] of Object.entries(METHODS)) {
      const resource = client[tag];
      for (const name of names) {
        const raw = resource?.withRawResponse[name];
        const id = /OPERATIONS\.(\w+)/.exec(raw?.toString() ?? "")?.[1] ?? "";
        const operation = operations[id];
        if (!resource || !operation) throw new Error(`${tag}.${name} sends no operation`);
        const pathArgs = Array((operation.path.match(/\{/g) ?? []).length).fill("p1");
        const result = resource[name]?.(...pathArgs, { body: {}, from: "x", to: "y", service_id: "s" });
        if (result instanceof PagePromise) paging.add(id);
        await Promise.resolve(result).catch(() => undefined);
      }
    }
    const expected = Object.values(operations).map(
      (operation) => `${operation.method} ${operation.path.replace(/\{[^}]+\}/g, "p1")}`,
    );
    expect(reached).toEqual(new Set(expected));
    expect(paging).toEqual(new Set(Object.keys(operations).filter((id) => operations[id]?.query.includes("cursor"))));
  });
});

describe("methods", () => {
  it("return the model and send their arguments", async () => {
    const recorder = new Recorder(json(200, { total: 7 }));
    const count = await make(recorder).calls.count({ location_id: "11111111-1111-1111-1111-111111111111" });
    expect(count).toEqual({ total: 7 });
    const [request] = recorder.requests;
    expect(request?.url.searchParams.get("location_id")).toBe("11111111-1111-1111-1111-111111111111");
    expect(request?.headers.get("Talki-Version")).toBeTruthy();
  });

  it("send a write's body as JSON with an idempotency key", async () => {
    const recorder = new Recorder(json(201, TAG));
    const tag = await make(recorder).tags.create({ body: { name: "VIP", color: "#ff0000" } });
    expect(tag.name).toBe("VIP");
    const [request] = recorder.requests;
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Idempotency-Key")).toBeTruthy();
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({ name: "VIP", color: "#ff0000" });
  });

  it("send per-request options as headers", async () => {
    const recorder = new Recorder(empty(204));
    expect(await make(recorder).tags.delete(TAG.id, { idempotencyKey: "mine", talkiVersion: "2026-01-01" })).toBe(
      undefined,
    );
    const [request] = recorder.requests;
    expect(request?.method).toBe("DELETE");
    expect([request?.headers.get("Idempotency-Key"), request?.headers.get("Talki-Version")]).toEqual([
      "mine",
      "2026-01-01",
    ]);
  });

  it("encode path parameters and leave out unset query parameters", async () => {
    const recorder = new Recorder(json(200, { data: [], has_more: false, next_cursor: null }));
    await make(recorder).tags.tagContact("a/b", "c d");
    await make(recorder).calls.list({ phone: null, sync: true, limit: 5, ...({ q: undefined } as object) });
    expect(recorder.requests[0]?.url.pathname).toBe("/v1/tags/a%2Fb/contacts/c%20d");
    expect(recorder.requests[1]?.url.search).toBe("?limit=5&sync=true");
  });

  it("throw the class of an error", async () => {
    const recorder = new Recorder(envelope(409, "conflict", "tag_exists"));
    const error = await make(recorder)
      .tags.create({ body: { name: "VIP", color: "#ff0000" } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("tag_exists");
  });

  it("return a file as a Blob", async () => {
    const recorder = new Recorder(
      new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const exported = await make(recorder).calls.exportCall("00000000-0000-0000-0000-000000000001");
    expect(exported).toBeInstanceOf(Blob);
    expect(exported.type).toBe("application/pdf");
    expect(await exported.text()).toBe("%PDF-1.7");
  });

  it("leave an optional body out, or send it", async () => {
    const pending = "00000000-0000-0000-0000-0000000000cc";
    const recorder = new Recorder(json(200, contact(1)));
    const client = make(recorder);
    await client.pendingContacts.approve(pending);
    await client.pendingContacts.approve(pending, { body: { first_name: "Ada" } });
    expect(recorder.requests[0]?.body).toBe("");
    expect(recorder.requests[0]?.headers.has("Content-Type")).toBe(false);
    expect(JSON.parse(recorder.requests[1]?.body ?? "")).toEqual({ first_name: "Ada" });
  });

  it("refuse a call without a required body or path parameter", async () => {
    const client = make(new Recorder(json(201, TAG)));
    await expect(client.tags.create({} as never)).rejects.toThrow(TypeError);
    await expect(client.calls.get("")).rejects.toThrow(TypeError);
  });

  it("send a Date in a body as its ISO string", async () => {
    const recorder = new Recorder(json(201, {}));
    await make(recorder).appointments.create({
      body: {
        client_name: "Ada",
        client_surname: "Lovelace",
        start_at: new Date(Date.UTC(2026, 10, 2, 9, 30)) as unknown as string,
      },
    });
    expect(JSON.parse(recorder.requests[0]?.body ?? "").start_at).toBe("2026-11-02T09:30:00.000Z");
  });
});

describe("pages", () => {
  it("a list awaited is its first page", async () => {
    const server = threePages();
    const page = await server.client().contacts.list({ limit: 2 });
    expect(page).toBeInstanceOf(Page);
    expect(page.data.map(tail)).toEqual(["01", "02"]);
    expect([page.hasMore, page.nextCursor]).toEqual([true, "c1"]);
    // Only the first page is fetched until the page is iterated.
    expect(server.cursors).toEqual([null]);
  });

  it("a list sends nothing until awaited or iterated", async () => {
    const server = threePages();
    const pager = server.client().contacts.list({ limit: 2 });
    expect(pager).toBeInstanceOf(PagePromise);
    await Promise.resolve();
    expect(server.cursors).toEqual([]);
    // Awaited twice, it is fetched once.
    expect(await pager).toBe(await pager);
    expect(server.cursors).toEqual([null]);
  });

  it("iterating a list yields every row from there on", async () => {
    const server = threePages();
    const walked = await collect(server.client().contacts.list({ limit: 2 }));
    expect(walked.map(tail)).toEqual(["01", "02", "03", "04"]);
    expect(server.cursors).toEqual([null, "c1", "c2"]);
    expect(server.requests.every((request) => request.url.searchParams.get("limit") === "2")).toBe(true);
  });

  it("a feed resumes from a stored cursor page by page", async () => {
    const server = threePages();
    let stored: string | null = "c1";
    for await (const page of server.client().contacts.list({ cursor: stored }).iterPages()) {
      stored = position(page, stored);
    }
    expect(server.cursors).toEqual(["c1", "c2"]);
    expect(stored).toBe("c3");
  });

  it("an empty page keeps the position it had", async () => {
    const server = new Server({ "/v1/contacts s1": () => contacts([], false, null) });
    const page = await server.client().contacts.list({ cursor: "s1" });
    expect(position(page, "s1")).toBe("s1");
    expect(position(page)).toBeNull();
  });

  it("iterating a page again starts from the same page", async () => {
    const server = threePages();
    const page = await server.client().contacts.list();
    const first = await collect(page);
    const second = await collect(page);
    expect(first).toEqual(second);
    // The first page is kept; the later ones are fetched each time.
    expect(server.cursors).toEqual([null, "c1", "c2", "c1", "c2"]);
  });

  it("pages and rows walk alike", async () => {
    const server = threePages();
    const page = await server.client().contacts.list({ limit: 2 });
    expect((await collect(page)).map(tail)).toEqual(["01", "02", "03", "04"]);
    expect((await collect(page.iterPages())).map((each) => each.data.length)).toEqual([2, 1, 1]);
    expect((await collect(server.client().contacts.list().iterPages())).length).toBe(3);
  });

  it("a failing first page throws from the await, or from the loop", async () => {
    const refused = () => envelope(400, "invalid_request", "invalid_cursor");
    const server = new Server({ "/v1/contacts bad": refused });
    await expect(server.client().contacts.list({ cursor: "bad" })).rejects.toThrow(InvalidRequestError);
    await expect(collect(server.client().contacts.list({ cursor: "bad" }))).rejects.toThrow(InvalidRequestError);
  });

  it("a failing later page throws after the rows before it", async () => {
    const server = new Server({
      "/v1/contacts": () => contacts([1], true, "c1"),
      "/v1/contacts c1": () => envelope(500, "api_error", "internal_error"),
    });
    const rows: string[] = [];
    await expect(
      (async () => {
        for await (const row of server.client().contacts.list()) rows.push(tail(row));
      })(),
    ).rejects.toThrow(ServerError);
    expect(rows).toEqual(["01"]);
  });

  it("more promised without a new cursor stops instead of looping", async () => {
    const server = new Server({ "/v1/contacts c0": () => contacts([1], true, "c0") });
    await expect(collect(server.client().contacts.list({ cursor: "c0" }))).rejects.toThrow(PaginationError);
    expect(server.cursors).toEqual(["c0"]);

    const none = new Server({ "/v1/contacts": () => contacts([1], true, null) });
    await expect(collect(none.client().contacts.list())).rejects.toThrow(PaginationError);
  });

  it("a list without a cursor returns its model", async () => {
    const server = new Server({ "/v1/tags": () => json(200, { data: [TAG], has_more: false, next_cursor: null }) });
    const tags = await server.client().tags.list();
    expect(tags).not.toBeInstanceOf(Page);
    expect(tags.data.map((tag) => tag.name)).toEqual(["VIP"]);
  });

  it("types the rows", async () => {
    const page = await new Server({ "/v1/calls": () => json(200, { data: [], has_more: false }) })
      .client()
      .calls.list();
    expectTypeOf(page).toEqualTypeOf<Page<Call>>();
    expectTypeOf(page.data).toEqualTypeOf<Call[]>();
  });
});

describe("the whole answer", () => {
  const HOURS = {
    location_id: "11111111-1111-1111-1111-111111111111",
    slots: [{ days: [1], start: "09:00", end: "13:00" }],
  };

  it("has the headers, and data is the value; the ETag goes back as ifMatch", async () => {
    const recorder = new Recorder(json(200, HOURS, { ETag: '"v1"', "X-Request-Id": "req_1" }), json(200, HOURS));
    const client = make(recorder);
    const raw = await client.workingHours.withRawResponse.get();
    expect([raw.status, raw.requestId]).toEqual([200, "req_1"]);
    expect(raw.data.slots[0]?.start).toBe("09:00");
    await client.workingHours.replace({ body: { slots: [] }, ifMatch: raw.headers.get("etag") ?? "" });
    expect(recorder.requests[1]?.headers.get("If-Match")).toBe('"v1"');
    expectTypeOf(raw).toMatchTypeOf<RawResponse<{ slots: unknown[] }>>();
  });

  it("throws as the method does", async () => {
    const recorder = new Recorder(envelope(409, "conflict", "tag_exists"));
    await expect(
      make(recorder).tags.withRawResponse.create({ body: { name: "VIP", color: "#ff0000" } }),
    ).rejects.toThrow(ConflictError);
  });

  it("of a list is a page that walks on", async () => {
    const server = threePages();
    const raw = await server.client().contacts.withRawResponse.list({ limit: 2 });
    expect(raw.data).toBeInstanceOf(Page);
    expect(raw.data.data).toHaveLength(2);
    expect(await collect(raw.data)).toHaveLength(4);
    expect(server.cursors).toEqual([null, "c1", "c2"]);
  });

  it("of no content has undefined data", async () => {
    const raw = await make(new Recorder(empty(204))).tags.withRawResponse.delete(TAG.id);
    expect([raw.status, raw.data]).toEqual([204, undefined]);
  });
});

describe("withOptions", () => {
  it("changes the settings for its calls only", async () => {
    const recorder = new Recorder(empty(503), empty(503), json(200, { total: 7 }));
    const client = make(recorder, { timeout: 30_000 });
    const once = client.withOptions({ maxRetries: 0, timeout: 5000 });
    expect(once).toBeInstanceOf(Talki);
    await expect(once.calls.count()).rejects.toThrow(ServerError);
    expect(recorder.requests).toHaveLength(1);
    // The original still retries.
    expect((await client.calls.count()).total).toBe(7);
    expect(recorder.requests).toHaveLength(3);
    expect(once.calls).not.toBe(client.calls);
    expect(once.version).toBe(client.version);
  });

  it("refuses a bad setting", () => {
    const client = new Talki({ apiKey: "k" });
    expect(() => client.withOptions({ maxRetries: -1 })).toThrow(RangeError);
    expect(() => client.withOptions({ timeout: -5 })).toThrow(RangeError);
  });
});
