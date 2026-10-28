// OAuth: the consent URL and callback, the token endpoints, and a `Talki`
// whose pair renews itself, against a mocked `fetch`.

import { describe, expect, it } from "vitest";
import { HOOKS, Talki, type TalkiOptions } from "../src/client.js";
import {
  AuthenticationError,
  authorizationUrl,
  ConnectionError,
  createPkce,
  OAuthApp,
  OAuthError,
  readCallback,
  type TokenSet,
} from "../src/index.js";
import type { Hooks } from "../src/transport.js";
import { dropped, json, Recorder, refused, type Seen } from "./helpers.js";

const BASIC = `Basic ${btoa("talki_cid_x:talki_cs_x")}`;

function pair(n: number, expiresIn: number | null = 3600): Record<string, unknown> {
  return {
    access_token: `talki_at_${n}`,
    token_type: "Bearer",
    ...(expiresIn === null ? {} : { expires_in: expiresIn }),
    refresh_token: `talki_rt_${n}`,
    scope: "calls:read account:read",
    account_id: "acc",
    installation_id: "inst",
    livemode: false,
  };
}

const UNAUTHENTICATED = {
  error: {
    type: "authentication_error",
    code: "invalid_credentials",
    message: "The supplied API credential is invalid.",
    request_id: "req_1",
  },
};
const expired = () => json(401, UNAUTHENTICATED, { "WWW-Authenticate": 'Bearer error="invalid_token"' });

function tokens(expiresAt: number | null): TokenSet {
  return {
    accessToken: "talki_at_1",
    refreshToken: "talki_rt_1",
    expiresAt,
    scopes: [],
    accountId: "",
    installationId: "",
    livemode: false,
  };
}

/** `/oauth/token` hands out pair n+1 for refresh token n; the API accepts only the newest access token. */
class Server {
  current = 1;
  readonly refreshes: string[] = [];
  readonly apiTokens: string[] = [];
  readonly recorder: Recorder;

  constructor(options: { failRefresh?: boolean; api?: (seen: Seen) => Response | null } = {}) {
    this.recorder = new Recorder((seen) => {
      if (seen.url.pathname === "/oauth/token") {
        const form = new URLSearchParams(seen.body);
        expect(seen.headers.get("Authorization")).toBe(BASIC);
        expect(form.get("grant_type")).toBe("refresh_token");
        const presented = form.get("refresh_token") ?? "";
        this.refreshes.push(presented);
        if (options.failRefresh || presented !== `talki_rt_${this.current}`) {
          return json(400, { error: "invalid_grant", error_description: "rotated" });
        }
        this.current += 1;
        return json(200, pair(this.current));
      }
      const token = (seen.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      this.apiTokens.push(token);
      const custom = options.api?.(seen);
      if (custom) return custom;
      if (token !== `talki_at_${this.current}`) return expired();
      return json(200, {});
    });
  }

  talki(options: Partial<TalkiOptions> & { hooks?: Hooks } = {}): Talki {
    const { hooks, ...rest } = options;
    return new Talki({
      tokens: tokens(0),
      oauthApp: new OAuthApp("talki_cid_x", "talki_cs_x", { fetch: this.recorder.fetch }),
      fetch: this.recorder.fetch,
      maxRetries: 0,
      ...rest,
      [HOOKS]: { sleep: async () => {}, ...hooks },
    } as TalkiOptions);
  }
}

describe("the consent round trip", () => {
  it("puts PKCE and the scopes in the consent URL", async () => {
    const pkce = await createPkce();
    const url = new URL(
      authorizationUrl("talki_cid_x", "https://crm.example/cb", ["calls:read", "account:read"], { state: "s1", pkce }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://app.talki.it/autorizza");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "talki_cid_x",
      redirect_uri: "https://crm.example/cb",
      scope: "calls:read account:read",
      state: "s1",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.verifier.length).toBeLessThanOrEqual(128);
    // S256: the challenge is the verifier's SHA-256, base64url without padding.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier)));
    expect(pkce.challenge).toBe(Buffer.from(digest).toString("base64url"));
  });

  it("adds prompt and enrollment when given", async () => {
    const url = new URL(
      authorizationUrl("c", "https://crm.example/cb", ["calls:read"], {
        state: "s",
        pkce: await createPkce(),
        prompt: "consent",
        enrollment: "enr_1",
        authorizeUrl: "https://app.example/consent",
      }),
    );
    expect([url.origin + url.pathname, url.searchParams.get("prompt"), url.searchParams.get("enrollment")]).toEqual([
      "https://app.example/consent",
      "consent",
      "enr_1",
    ]);
  });

  it.each([
    ["https://crm.example/cb?error=access_denied&state=s1&iss=https://api.talki.it", "access_denied"],
    ["https://crm.example/cb?code=c&state=other&iss=https://api.talki.it", "state_mismatch"],
    ["https://crm.example/cb?code=c&state=s1&iss=https://evil.example", "issuer_mismatch"],
    ["https://crm.example/cb?code=c&state=s1", "issuer_mismatch"],
    ["https://crm.example/cb?state=s1&iss=https://api.talki.it", "missing_code"],
    ["https://crm.example/cb?code=&state=s1&iss=https://api.talki.it", "missing_code"],
    ["https://crm.example/cb?code=c&state=é&iss=https://api.talki.it", "state_mismatch"],
  ])("refuses a callback that is not a code for this request: %s", (callback, error) => {
    expect(() => readCallback(callback, { state: "s1" })).toThrow(expect.objectContaining({ error }));
  });

  it("gives a good callback's code", () => {
    expect(readCallback("https://crm.example/cb?code=c1&state=s1&iss=https://api.talki.it", { state: "s1" })).toBe(
      "c1",
    );
    expect(readCallback("?code=c1&state=s1&iss=https://api.talki.it/", { state: "s1" })).toBe("c1");
    expect(readCallback("code=c1&state=s1&iss=https://api.talki.it", { state: "s1" })).toBe("c1");
    expect(() => readCallback("https://crm.example/cb?code=c&iss=https://api.talki.it", { state: "" })).toThrow(
      TypeError,
    );
  });
});

describe("the token endpoints", () => {
  it("exchange a code", async () => {
    const recorder = new Recorder(json(200, pair(1)));
    const app = new OAuthApp("talki_cid_x", "talki_cs_x", { fetch: recorder.fetch });
    const before = Date.now();
    const got = await app.exchangeCode("c1", { redirectUri: "https://crm.example/cb", codeVerifier: "v".repeat(64) });
    const [request] = recorder.requests;
    expect(request?.headers.get("Authorization")).toBe(BASIC);
    expect(request?.headers.get("User-Agent")).toMatch(/^talki-typescript\//);
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toEqual({
      grant_type: "authorization_code",
      code: "c1",
      redirect_uri: "https://crm.example/cb",
      code_verifier: "v".repeat(64),
    });
    expect([got.accessToken, got.refreshToken, got.scopes, got.livemode]).toEqual([
      "talki_at_1",
      "talki_rt_1",
      ["calls:read", "account:read"],
      false,
    ]);
    expect(got.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(String(app)).not.toContain("talki_cs_x");
    expect(JSON.stringify(app)).not.toContain("talki_cs_x");
  });

  it("throw an OAuthError for a refused exchange", async () => {
    const recorder = new Recorder(json(400, { error: "invalid_grant", error_description: "spent" }));
    const app = new OAuthApp("talki_cid_x", "talki_cs_x", { fetch: recorder.fetch });
    const error = await app
      .exchangeCode("c1", { redirectUri: "https://crm.example/cb", codeVerifier: "v" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthError);
    expect([(error as OAuthError).error, (error as OAuthError).status]).toEqual(["invalid_grant", 400]);
  });

  it("refresh with scopes and revoke", async () => {
    const recorder = new Recorder(json(200, pair(2, null)), json(200, {}));
    const app = new OAuthApp("talki_cid_x", "talki_cs_x", { fetch: recorder.fetch });
    expect((await app.refresh("talki_rt_1", { scopes: ["calls:read"] })).expiresAt).toBeNull();
    expect(new URLSearchParams(recorder.requests[0]?.body).get("scope")).toBe("calls:read");
    await app.revoke("talki_rt_2");
    expect(recorder.requests[1]?.url.pathname).toBe("/oauth/revoke");
    expect(Object.fromEntries(new URLSearchParams(recorder.requests[1]?.body))).toEqual({ token: "talki_rt_2" });
  });

  it("form-encode the credentials before Basic", () => {
    const request = new OAuthApp("id with space", "s&cret:é").tokenRequest({ grant_type: "x" });
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob((request.headers.get("Authorization") ?? "").slice(6)), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe("id+with+space:s%26cret%3A%C3%A9");
  });
});

describe("a pair that renews itself", () => {
  it("renews once on a 401 invalid_token, and sends the request again", async () => {
    const saved: TokenSet[] = [];
    const server = new Server({
      api: (seen) => (seen.headers.get("Authorization") === "Bearer talki_at_1" ? expired() : null),
    });
    const talki = server.talki({ tokens: tokens(null), onTokenRefresh: (pair) => void saved.push(pair) });
    await talki.account.get();
    expect(server.refreshes).toEqual(["talki_rt_1"]);
    expect(server.apiTokens).toEqual(["talki_at_1", "talki_at_2"]);
    expect(saved.map((pair) => pair.refreshToken)).toEqual(["talki_rt_2"]);
    expect(talki.tokens?.accessToken).toBe("talki_at_2");
  });

  it("renews a pair about to expire before the request", async () => {
    const saved: TokenSet[] = [];
    const server = new Server();
    await server.talki({ onTokenRefresh: (pair) => void saved.push(pair) }).account.get();
    expect(server.refreshes).toEqual(["talki_rt_1"]);
    expect(server.apiTokens).toEqual(["talki_at_2"]);
    expect(saved).toHaveLength(1);
  });

  it("renews within the leeway, and not before", async () => {
    const server = new Server();
    const now = 1_000_000;
    const fresh = server.talki({ tokens: tokens(now + 61_000), hooks: { clock: () => now } });
    await fresh.account.get();
    expect(server.refreshes).toEqual([]);
    const due = server.talki({ tokens: tokens(now + 60_000), hooks: { clock: () => now } });
    await due.account.get();
    expect(server.refreshes).toEqual(["talki_rt_1"]);
  });

  it("leaves a 401 without invalid_token alone", async () => {
    const recorder = new Recorder(json(401, UNAUTHENTICATED));
    const talki = new Talki({
      tokens: tokens(null),
      oauthApp: new OAuthApp("talki_cid_x", "talki_cs_x"),
      fetch: recorder.fetch,
    });
    await expect(talki.account.get()).rejects.toThrow(AuthenticationError);
    expect(recorder.paths).toEqual(["/v1/account"]);
  });

  it("throws a refused refresh and keeps the old pair", async () => {
    const server = new Server({ failRefresh: true });
    const talki = server.talki();
    const error = await talki.account.get().catch((caught: unknown) => caught);
    expect((error as OAuthError).error).toBe("invalid_grant");
    expect(talki.tokens?.refreshToken).toBe("talki_rt_1");
  });

  it("never uses a pair that could not be stored", async () => {
    const server = new Server();
    const talki = server.talki({
      onTokenRefresh: () => {
        throw new Error("disk full");
      },
    });
    await expect(talki.account.get()).rejects.toThrow("disk full");
    expect(talki.tokens?.accessToken).toBe("talki_at_1");
    expect(server.apiTokens).toEqual([]);
  });

  it("stores a pending pair before anything else, never refreshing again", async () => {
    const server = new Server();
    const attempts: TokenSet[] = [];
    const talki = server.talki({
      onTokenRefresh: async (pair) => {
        attempts.push(pair);
        if (attempts.length === 1) throw new Error("disk full");
      },
    });
    await expect(talki.account.get()).rejects.toThrow("disk full");
    await talki.account.get();
    expect(server.refreshes).toEqual(["talki_rt_1"]);
    expect(attempts.map((pair) => pair.refreshToken)).toEqual(["talki_rt_2", "talki_rt_2"]);
    expect(server.apiTokens).toEqual(["talki_at_2"]);
  });

  it("refuses a request made on the same client from onTokenRefresh instead of hanging", async () => {
    const server = new Server();
    const seen: unknown[] = [];
    const talki: Talki = server.talki({
      onTokenRefresh: async () => {
        seen.push(await talki.calls.count().catch((caught: unknown) => caught));
      },
    });
    await talki.account.get();
    expect(seen).toHaveLength(1);
    expect(String((seen[0] as Error).message)).toContain("onTokenRefresh");
    // The renewal itself went through, once.
    expect(server.refreshes).toEqual(["talki_rt_1"]);
    expect(talki.tokens?.refreshToken).toBe("talki_rt_2");
  });

  it("never stores a token answer without its tokens", async () => {
    const stored: TokenSet[] = [];
    const recorder = new Recorder((seen) =>
      seen.url.pathname === "/oauth/token" ? json(200, { token_type: "Bearer", expires_in: 3600 }) : json(200, {}),
    );
    const talki = new Talki({
      tokens: tokens(0),
      oauthApp: new OAuthApp("talki_cid_x", "talki_cs_x", { fetch: recorder.fetch }),
      onTokenRefresh: (pair) => {
        stored.push(pair);
      },
      fetch: recorder.fetch,
      maxRetries: 0,
      [HOOKS]: { sleep: async () => {} },
    } as TalkiOptions);
    const error = await talki.account.get().catch((caught: unknown) => caught);
    expect((error as OAuthError).error).toBe("invalid_response");
    expect(stored).toEqual([]);
    expect(talki.tokens?.refreshToken).toBe("talki_rt_1");
  });

  it("waits for an async onTokenRefresh before using the pair", async () => {
    const server = new Server();
    const order: string[] = [];
    const talki = server.talki({
      onTokenRefresh: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("stored");
      },
    });
    await talki.account.get();
    order.push("answered");
    expect(order).toEqual(["stored", "answered"]);
  });

  it("renews once for many requests at the same time", async () => {
    const server = new Server();
    const talki = server.talki();
    await Promise.all(Array.from({ length: 16 }, () => talki.account.get()));
    expect(server.refreshes).toEqual(["talki_rt_1"]);
  });

  it("renews once for its copies with other options too", async () => {
    const server = new Server();
    const talki = server.talki();
    const copies = [
      talki,
      talki.withOptions({ timeout: 5000 }),
      talki.withOptions({ maxRetries: 1 }).withOptions({ timeout: 7000 }),
    ];
    await Promise.all(Array.from({ length: 12 }, (_, n) => copies[n % 3]?.account.get()));
    expect(server.refreshes).toEqual(["talki_rt_1"]);
    expect(new Set(copies.map((copy) => copy.tokens?.accessToken))).toEqual(new Set(["talki_at_2"]));
  });

  it("fails fast once the installation is revoked", async () => {
    const server = new Server({ failRefresh: true });
    const talki = server.talki();
    const errors: unknown[] = [];
    for (let i = 0; i < 3; i++) errors.push(await talki.account.get().catch((caught: unknown) => caught));
    expect(errors.every((error) => error instanceof OAuthError && error.error === "invalid_grant")).toBe(true);
    expect(server.refreshes).toEqual(["talki_rt_1"]);
    // A new error each time.
    expect(errors[1]).not.toBe(errors[2]);
  });

  it("asks once about wrong app credentials", async () => {
    const recorder = new Recorder(json(401, { error: "invalid_client", error_description: "wrong secret" }));
    const talki = new Talki({
      tokens: tokens(0),
      oauthApp: new OAuthApp("talki_cid_x", "talki_cs_wrong"),
      fetch: recorder.fetch,
    });
    for (let i = 0; i < 3; i++) {
      await expect(talki.account.get()).rejects.toThrow(expect.objectContaining({ error: "invalid_client" }));
    }
    expect(recorder.paths).toEqual(["/oauth/token"]);
  });

  it("sends a write answered 401 again with its body and key", async () => {
    const bodies: Seen[] = [];
    const server = new Server({
      api: (seen) => {
        if (seen.url.pathname !== "/v1/tags") return null;
        bodies.push(seen);
        return seen.headers.get("Authorization") === "Bearer talki_at_1" ? expired() : json(201, {});
      },
    });
    await server.talki({ tokens: tokens(null) }).tags.create({ body: { name: "VIP", color: "#e0867a" } });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.body).toBe(bodies[1]?.body);
    expect(JSON.parse(bodies[0]?.body ?? "").name).toBe("VIP");
    expect(bodies[0]?.headers.get("Idempotency-Key")).toBe(bodies[1]?.headers.get("Idempotency-Key"));
  });

  it("returns a second 401 instead of looping", async () => {
    const server = new Server({ api: () => expired() });
    await expect(server.talki({ tokens: tokens(null) }).account.get()).rejects.toThrow(AuthenticationError);
    expect(server.refreshes).toEqual(["talki_rt_1"]);
  });

  it("retries a refresh turned away with 429", async () => {
    let first = true;
    const server = new Server();
    const recorder = new Recorder((seen, init) => {
      if (seen.url.pathname === "/oauth/token" && first) {
        first = false;
        return json(429, { error: { type: "rate_limit_error", code: "rate_limited" } });
      }
      return server.recorder.fetch(seen.url.toString(), init);
    });
    const waits: number[] = [];
    const talki = new Talki({
      tokens: tokens(0),
      oauthApp: new OAuthApp("talki_cid_x", "talki_cs_x"),
      fetch: recorder.fetch,
      [HOOKS]: { sleep: async (seconds: number) => void waits.push(seconds) },
    } as TalkiOptions);
    await talki.account.get();
    expect(waits).toHaveLength(1);
    expect(server.refreshes).toEqual(["talki_rt_1"]);
  });
});

describe("the settings", () => {
  it("takes oauthApp only with tokens", () => {
    expect(() => new Talki({ accessToken: "a", oauthApp: new OAuthApp("c", "s") })).toThrow(TypeError);
  });

  it("takes onTokenRefresh only with oauthApp", () => {
    expect(() => new Talki({ tokens: tokens(null), onTokenRefresh: () => {} })).toThrow(/oauthApp/);
  });

  it("renews a pair where it was issued", () => {
    expect(
      () =>
        new Talki({ tokens: tokens(null), oauthApp: new OAuthApp("c", "s"), baseUrl: "https://api.sandbox.example" }),
    ).toThrow(TypeError);
  });

  it("keeps a pair that does not renew as it was given", () => {
    const talki = new Talki({ tokens: tokens(null) });
    expect(talki.tokens?.accessToken).toBe("talki_at_1");
    expect(talki.withOptions({ timeout: 1000 }).tokens?.accessToken).toBe("talki_at_1");
    expect(new Talki({ apiKey: "k" }).tokens).toBeNull();
  });
});

// A refresh whose outcome is unknown. The server takes the same refresh token
// once more within 60 s of its first rotation; an overlap, or a presentation
// after that, revokes the installation.

type Step = Response | Error | [number, Response | Error];

/**
 * The token endpoint answers refreshes in turn from ``script`` (then with pair
 * 2): an answer, an error, or ``[seconds, either]`` for one that ends that
 * long after it was sent. ``now`` is the renewal's clock, moved only by the
 * script and its waits; ``timeline`` logs both.
 */
class Wire {
  now = 1000;
  readonly timeline: string[] = [];
  readonly transportWaits: number[] = [];
  readonly script: Step[];

  constructor(...script: Step[]) {
    this.script = script;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    if (new URL(input).pathname !== "/oauth/token") {
      this.timeline.push("GET");
      return json(200, {});
    }
    expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("talki_rt_1");
    this.timeline.push(`refresh at ${this.now}`);
    let step: Step = this.script.shift() ?? json(200, pair(2));
    if (Array.isArray(step)) {
      this.now += step[0];
      step = step[1];
    }
    if (step instanceof Error) throw step;
    return step;
  };

  talki(): Talki {
    return new Talki({
      tokens: tokens(0),
      oauthApp: new OAuthApp("talki_cid_x", "talki_cs_x"),
      fetch: this.fetch,
      [HOOKS]: {
        sleep: async (seconds: number) => void this.transportWaits.push(seconds),
        renewalSleep: async (seconds: number) => {
          this.timeline.push(`wait ${seconds}`);
          this.now += seconds;
        },
        monotonic: () => this.now,
      },
    } as TalkiOptions);
  }
}

const gateway = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });

describe("a refresh whose outcome is unknown", () => {
  it("is presented again after the settle when its connection broke", async () => {
    const wire = new Wire(dropped());
    const talki = wire.talki();
    await talki.account.get();
    expect(wire.timeline).toEqual(["refresh at 1000", "wait 10", "refresh at 1010", "GET"]);
    expect(wire.transportWaits).toEqual([]);
    expect(talki.tokens?.refreshToken).toBe("talki_rt_2");
  });

  it("is presented again within the grace, the wait timed from the failure", async () => {
    const wire = new Wire([30, dropped()]);
    await wire.talki().account.get();
    expect(wire.timeline).toEqual(["refresh at 1000", "wait 10", "refresh at 1040", "GET"]);
  });

  it("throws when too late for the grace, and the next request waits", async () => {
    const wire = new Wire([50, dropped()]);
    const talki = wire.talki();
    await expect(talki.account.get()).rejects.toThrow(ConnectionError);
    wire.now += 4;
    await talki.account.get();
    expect(wire.timeline).toEqual(["refresh at 1000", "wait 6", "refresh at 1060", "GET"]);
  });

  it("counts a gateway failure as an unknown outcome", async () => {
    const wire = new Wire(gateway());
    await wire.talki().account.get();
    expect(wire.timeline).toEqual(["refresh at 1000", "wait 10", "refresh at 1010", "GET"]);
    expect(wire.transportWaits).toEqual([]);
  });

  it("throws gateway failures past the grace, and leaves the next request waiting", async () => {
    const wire = new Wire(...Array.from({ length: 6 }, gateway));
    const talki = wire.talki();
    const error = await talki.account.get().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).status).toBe(502);
    expect(wire.timeline.filter((entry) => entry.startsWith("refresh"))).toEqual(
      [1000, 1010, 1020, 1030, 1040, 1050].map((at) => `refresh at ${at}`),
    );
    wire.now += 1;
    await talki.account.get();
    expect(wire.timeline.slice(-3)).toEqual(["wait 9", "refresh at 1060", "GET"]);
  });

  it("is retried at once when it never connected, and leaves no doubt", async () => {
    const wire = new Wire(refused(), refused(), refused());
    const talki = wire.talki();
    const error = await talki.account.get().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).sent).toBe(false);
    expect(wire.transportWaits).toHaveLength(2);
    await talki.account.get();
    expect(wire.timeline).toEqual(["refresh at 1000", "refresh at 1000", "refresh at 1000", "refresh at 1000", "GET"]);
  });
});

describe("logging", () => {
  function logged() {
    const lines: string[] = [];
    const logger = {
      debug: (message: string) => void lines.push(`debug ${message}`),
      info: (message: string) => void lines.push(`info ${message}`),
      warn: (message: string) => void lines.push(`warn ${message}`),
      error: (message: string) => void lines.push(`error ${message}`),
    };
    return { lines, logger };
  }

  it("logs a renewal and never a token", async () => {
    const { lines, logger } = logged();
    await new Server().talki({ logger, logLevel: "debug" }).account.get();
    expect(lines.filter((line) => line.includes("Renewed"))).toEqual([
      "info Renewed the access token of installation inst.",
    ]);
    expect(lines.join("\n")).not.toMatch(/talki_at_|talki_rt_|talki_cs_/);
  });

  it("logs a refused renewal as an error", async () => {
    const { lines, logger } = logged();
    await new Server({ failRefresh: true })
      .talki({ logger, logLevel: "info" })
      .account.get()
      .catch(() => undefined);
    expect(lines).toEqual([
      "error The API refused the token renewal (invalid_grant): the customer has to reconnect the app",
    ]);
  });

  it("warns of a renewal whose outcome is unknown", async () => {
    const { lines, logger } = logged();
    const wire = new Wire(gateway());
    const talki = new Talki({
      tokens: tokens(0),
      oauthApp: new OAuthApp("talki_cid_x", "talki_cs_x"),
      fetch: wire.fetch,
      logger,
      logLevel: "warn",
      [HOOKS]: { renewalSleep: async () => {}, monotonic: () => wire.now },
    } as TalkiOptions);
    await talki.account.get();
    expect(lines).toEqual([
      "warn A token renewal ended in a gateway error, its outcome unknown; presenting it again in 10 s.",
    ]);
  });
});
