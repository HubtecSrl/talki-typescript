// What the client says about itself and where it finds its key: the version,
// the `User-Agent`, `TALKI_API_KEY`, and the log.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Talki, USER_AGENT, VERSION } from "../src/index.js";
import { OAUTH_USER_AGENT } from "../src/oauth.js";
import { dropped, empty, json, make, Recorder, refused } from "./helpers.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const count = () => json(200, { total: 7 });

describe("version and User-Agent", () => {
  it("is the version released", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("names the client and the runtime on every request", async () => {
    const recorder = new Recorder(count());
    await make(recorder).calls.count();
    const agent = recorder.requests[0]?.headers.get("User-Agent");
    expect(agent).toBe(USER_AGENT);
    expect(agent).toBe(`talki-typescript/${VERSION} node/${process.versions.node}`);
  });

  it("adds an integration's own name after the client's, on copies too", async () => {
    const recorder = new Recorder(count());
    await make(recorder, { userAgent: " acme-crm/2.1 " }).withOptions({ timeout: 5000 }).calls.count();
    expect(recorder.requests[0]?.headers.get("User-Agent")).toBe(`${USER_AGENT} acme-crm/2.1`);
  });

  it.each(["", "  ", "acme\r\nX-Injected: 1", "café/1"])(
    "refuses a User-Agent that is not one line: %j",
    (userAgent) => {
      expect(() => new Talki({ apiKey: "k", userAgent })).toThrow(TypeError);
    },
  );

  it("names the client on token requests too", () => {
    expect(OAUTH_USER_AGENT).toBe(`talki-typescript/${VERSION}`);
  });
});

describe("TALKI_API_KEY", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TALKI_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TALKI_API_KEY;
    else process.env.TALKI_API_KEY = saved;
  });

  it("is the key when no credential is passed", async () => {
    process.env.TALKI_API_KEY = "talki_test_from_env";
    const recorder = new Recorder(count());
    await new Talki({ fetch: recorder.fetch }).calls.count();
    expect(recorder.requests[0]?.headers.get("Authorization")).toBe("Bearer talki_test_from_env");
  });

  it.each([{ apiKey: "talki_test_given" }, { accessToken: "talki_test_given" }])(
    "loses to a credential passed",
    async (given) => {
      process.env.TALKI_API_KEY = "talki_test_from_env";
      const recorder = new Recorder(count());
      await new Talki({ ...given, fetch: recorder.fetch }).calls.count();
      expect(recorder.requests[0]?.headers.get("Authorization")).toBe("Bearer talki_test_given");
    },
  );

  it.each([undefined, "", "  "])("says where to put one when there is none (%j)", (value) => {
    if (value === undefined) delete process.env.TALKI_API_KEY;
    else process.env.TALKI_API_KEY = value;
    expect(() => new Talki()).toThrow(/TALKI_API_KEY/);
  });
});

describe("the log", () => {
  function logged() {
    const lines: Array<[string, string]> = [];
    const logger = {
      debug: (message: string) => void lines.push(["debug", message]),
      info: (message: string) => void lines.push(["info", message]),
      warn: (message: string) => void lines.push(["warn", message]),
      error: (message: string) => void lines.push(["error", message]),
    };
    return { lines, logger };
  }

  it("has every answer at debug, without its query or headers", async () => {
    const { lines, logger } = logged();
    const recorder = new Recorder(json(200, { data: [], has_more: false, next_cursor: null }));
    await make(recorder, { logger, logLevel: "debug" }).calls.list({ phone: "+390000000001", q: "Rossi" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[0]).toBe("debug");
    expect(lines[0]?.[1]).toMatch(/^GET \/v1\/calls: 200 in \d+ ms$/);
    const text = lines.join("\n");
    expect(text).not.toContain("0000000001");
    expect(text).not.toContain("Rossi");
    expect(text).not.toContain("talki_test_x");
  });

  it("has a retry at info, with the request ID", async () => {
    const { lines, logger } = logged();
    await make(new Recorder(empty(503, { "X-Request-Id": "req_1" }), count()), {
      logger,
      logLevel: "info",
    }).calls.count();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toMatch(/^GET \/v1\/calls\/count: 503, request req_1; retry 1 of 2 in \d+\.\d s$/);
  });

  it("has a connection error retried and then given up on", async () => {
    const { lines, logger } = logged();
    await make(new Recorder(refused()), { logger, logLevel: "debug", maxRetries: 1 })
      .calls.count()
      .catch(() => undefined);
    expect(lines[0]?.[1]).toMatch(/^GET \/v1\/calls\/count: ConnectionError; retry 1 of 1 in /);
    expect(lines[1]?.[1]).toMatch(/^GET \/v1\/calls\/count: ConnectionError after \d+ ms$/);
  });

  it("has nothing at info for a plain answer, and nothing at all by default", async () => {
    const { lines, logger } = logged();
    await make(new Recorder(count()), { logger, logLevel: "info" }).calls.count();
    await make(new Recorder(dropped(), count()), { logger }).calls.count();
    expect(lines).toEqual([]);
  });

  it("refuses an unknown level", () => {
    expect(() => new Talki({ apiKey: "k", logLevel: "verbose" as never })).toThrow(TypeError);
  });
});
