/**
 * OAuth for an app installed on Talki accounts: the consent URL, the code
 * exchange, refresh, revocation, and an access token that renews itself.
 *
 *     import { Talki } from "@hubtec/talki";
 *     import { OAuthApp, createPkce, authorizationUrl, readCallback } from "@hubtec/talki/oauth";
 *
 *     const app = new OAuthApp(clientId, clientSecret);
 *     const pkce = await createPkce();
 *     const url = authorizationUrl(clientId, redirectUri, ["calls:read"], { state, pkce });
 *     // … send the browser to url; on the callback:
 *     const code = readCallback(callbackUrl, { state });
 *     const tokens = await app.exchangeCode(code, { redirectUri, codeVerifier: pkce.verifier });
 *     await save(tokens);
 *
 *     const talki = new Talki({ tokens, oauthApp: app, onTokenRefresh: save });
 *
 * `/oauth/token` and `/oauth/revoke` answer in RFC 6749's shape
 * (`{"error", "error_description"}`), thrown here as `OAuthError`.
 *
 * **A refresh token rotates on every use.** Store the new pair before the new
 * access token is used: `onTokenRefresh` is called with it, and the request
 * waits for it. Presenting a rotated refresh token again revokes the whole
 * installation, so the renewals of one `Talki` (and of its `withOptions`
 * copies) are serialised; never renew one pair from two clients or processes.
 *
 * The server takes a rotated refresh token once more within `REFRESH_GRACE`
 * seconds of its rotation, as the retry of a refresh whose answer was lost.
 * So a refresh whose outcome is unknown is presented again within the same
 * request, once the first has had `REFRESH_SETTLE` seconds to finish. When
 * that would fall outside the grace (a timeout above 45 seconds), the request
 * throws; the next one presents the token again, which works only if the
 * first never reached the server. Otherwise the customer has to reconnect.
 */

import { ConnectionError, REQUEST_ID_HEADER, TalkiError } from "./errors.js";
import { type Log, SILENT } from "./logging.js";
import {
  type Answer,
  type Fetch,
  GATEWAY_STATUSES,
  type Hooks,
  monotonic,
  type OutgoingRequest,
  sleep,
  type Transport,
} from "./transport.js";
import { VERSION } from "./version.js";

export const DEFAULT_AUTHORIZE_URL = "https://app.talki.it/autorizza";
export const DEFAULT_ISSUER = "https://api.talki.it";
/** Renew an access token this many seconds before it expires. */
export const REFRESH_LEEWAY = 60;
/**
 * How long after a refresh token's first rotation the server takes it once
 * more, as the retry of a refresh whose answer was lost. Later, presenting it
 * revokes the installation.
 */
export const REFRESH_GRACE = 60;
/**
 * After a refresh whose outcome is unknown (sent, then its answer lost, timed
 * out, or a gateway's 5xx), wait this long before presenting the same refresh
 * token again: long enough for the first to finish on the server, so the
 * second is not an overlap (which revokes the pair), and well inside the grace.
 */
export const REFRESH_SETTLE = 10;
/**
 * A refresh is presented again within the same request only if it goes out
 * this long before the grace ends, counted from the first send: room for it
 * to reach the server.
 */
export const GRACE_MARGIN = 5;

/** The `User-Agent` of a token request: this package's alone. */
export const OAUTH_USER_AGENT = `talki-typescript/${VERSION}`;

/** An RFC 6749 error, from the token endpoints or on the callback. */
export class OAuthError extends TalkiError {
  override name = "OAuthError";
  /** The RFC 6749 error code: `invalid_grant`, `invalid_client`, `access_denied`, … */
  readonly error: string;
  readonly description: string;
  /** The HTTP status, when the error came from an endpoint. */
  readonly status: number | null;
  readonly requestId: string | null;

  constructor(error: string, description = "", options: { status?: number | null; requestId?: string | null } = {}) {
    super(description ? `${error}: ${description}` : error);
    this.error = error;
    this.description = description;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
  }
}

/** A PKCE pair: send `challenge` in the consent URL, `verifier` with the code. */
export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new PKCE pair (S256). */
export async function createPkce(): Promise<Pkce> {
  // 48 random bytes: 64 characters, inside RFC 7636's 43–128.
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/**
 * One installation's token pair, as `/oauth/token` answers it. A plain
 * object, to store as JSON and pass back as `tokens`. It holds secrets: never
 * log it.
 */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** When the access token expires, in milliseconds since the epoch; null when not said. */
  readonly expiresAt: number | null;
  readonly scopes: readonly string[];
  readonly accountId: string;
  readonly installationId: string;
  readonly livemode: boolean;
}

/** The pair in a `/oauth/token` answer, its expiry counted from ``now`` (milliseconds since the epoch). */
export function tokenSetFromBody(body: Record<string, unknown>, now: number = Date.now()): TokenSet {
  const expiresIn = body.expires_in;
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  if (typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken) {
    // Stored, a pair without its tokens would replace the caller's refresh
    // token with nothing usable, and the next renewal would end the
    // installation.
    throw new OAuthError("invalid_response", "The token answer has no access_token or refresh_token.");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: typeof expiresIn === "number" ? now + expiresIn * 1000 : null,
    // Space-delimited, per RFC 6749 §5.1.
    scopes: String(body.scope || "")
      .split(/\s+/)
      .filter(Boolean),
    accountId: String(body.account_id || ""),
    installationId: String(body.installation_id || ""),
    livemode: body.livemode === undefined ? true : Boolean(body.livemode),
  };
}

export interface AuthorizationUrlOptions {
  /** A value you keep, to check on the callback. */
  state: string;
  pkce: Pkce;
  /** `"consent"` replaces the grant with exactly ``scopes``. */
  prompt?: string;
  /** A billing partner's activation. */
  enrollment?: string;
  /** The consent page of another deployment. */
  authorizeUrl?: string;
}

/** The consent page to send the customer's browser to. */
export function authorizationUrl(
  clientId: string,
  redirectUri: string,
  scopes: readonly string[],
  options: AuthorizationUrlOptions,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state: options.state,
    code_challenge: options.pkce.challenge,
    code_challenge_method: "S256",
  });
  if (options.prompt) params.set("prompt", options.prompt);
  if (options.enrollment) params.set("enrollment", options.enrollment);
  return `${options.authorizeUrl ?? DEFAULT_AUTHORIZE_URL}?${params}`;
}

function sameText(a: string, b: string): boolean {
  // Compared in full whatever differs first, so the time taken says nothing of where.
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let differ = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) differ |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return differ === 0;
}

/**
 * The code on the callback URL (or its query string). Throws `OAuthError` for
 * a `state` that is not yours, an `iss` that is not Talki's, or a refusal
 * (`access_denied` when the customer declines).
 */
export function readCallback(url: string, options: { state: string; issuer?: string }): string {
  if (!options.state) throw new TypeError("Pass the state sent in the consent URL.");
  const at = url.indexOf("?");
  const search = (at === -1 ? url : url.slice(at + 1)).split("#")[0] ?? "";
  // A blank value counts as none.
  const query = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(search)) {
    if (value !== "" && !query.has(name)) query.set(name, value);
  }
  if (!sameText(query.get("state") ?? "", options.state)) {
    throw new OAuthError("state_mismatch", "The callback's state is not the one sent.");
  }
  const issuer = options.issuer ?? DEFAULT_ISSUER;
  if ((query.get("iss") ?? "").replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw new OAuthError("issuer_mismatch", "The callback's iss is not Talki's.");
  }
  const error = query.get("error");
  if (error !== undefined) throw new OAuthError(error, query.get("error_description") ?? "");
  const code = query.get("code");
  if (code === undefined) throw new OAuthError("missing_code", "The callback carries neither a code nor an error.");
  return code;
}

function failure(answer: Answer): OAuthError {
  const text = new TextDecoder().decode(answer.body);
  const requestId = answer.headers.get(REQUEST_ID_HEADER);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
    const { error, error_description } = body as { error: string; error_description?: unknown };
    return new OAuthError(error, error_description ? String(error_description) : "", {
      status: answer.status,
      requestId,
    });
  }
  return new OAuthError("unexpected_response", text.slice(0, 300), { status: answer.status, requestId });
}

function tokensFrom(answer: Answer, now?: number): TokenSet {
  if (answer.status < 200 || answer.status >= 300) throw failure(answer);
  return tokenSetFromBody(JSON.parse(new TextDecoder().decode(answer.body)) as Record<string, unknown>, now);
}

function formValue(value: string): string {
  // application/x-www-form-urlencoded, as RFC 6749 §2.3.1 asks of each half.
  return new URLSearchParams([["", value]]).toString().slice(1);
}

/** An app's credentials, for the token endpoints. Client authentication is HTTP Basic. */
export class OAuthApp {
  readonly clientId: string;
  readonly baseUrl: string;
  readonly #clientSecret: string;
  readonly #timeout: number;
  readonly #fetch: Fetch;

  /**
   * @param options.baseUrl - the API's origin, for another deployment.
   * @param options.timeout - milliseconds before a token request is abandoned.
   * @param options.fetch - the `fetch` to send with; the global one by default.
   */
  constructor(
    clientId: string,
    clientSecret: string,
    options: { baseUrl?: string; timeout?: number; fetch?: Fetch } = {},
  ) {
    this.clientId = clientId;
    this.#clientSecret = clientSecret;
    this.baseUrl = (options.baseUrl ?? DEFAULT_ISSUER).replace(/\/+$/, "");
    this.#timeout = options.timeout ?? 30_000;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get tokenUrl(): string {
    return `${this.baseUrl}/oauth/token`;
  }

  /** A token request, as the transport sends it. */
  tokenRequest(form: Record<string, string>, path = "/oauth/token", timeout = this.#timeout): OutgoingRequest {
    const basic = btoa(
      String.fromCharCode(...new TextEncoder().encode(`${formValue(this.clientId)}:${formValue(this.#clientSecret)}`)),
    );
    return {
      method: "POST",
      url: `${this.baseUrl}${path}`,
      headers: new Headers({
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": OAUTH_USER_AGENT,
      }),
      body: new URLSearchParams(form).toString(),
      timeout,
    };
  }

  async #send(request: OutgoingRequest): Promise<Answer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout);
    try {
      const response = await this.#fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ?? null,
        signal: controller.signal,
        redirect: "manual",
      });
      return { status: response.status, headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The pair for a callback's code. A code works once: presenting it again
   * revokes the installation, so never retry this with the same code.
   */
  async exchangeCode(code: string, options: { redirectUri: string; codeVerifier: string }): Promise<TokenSet> {
    const form = {
      grant_type: "authorization_code",
      code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
    };
    return tokensFrom(await this.#send(this.tokenRequest(form)));
  }

  /** A new pair. The old refresh token stops working: store the new one first. */
  async refresh(refreshToken: string, options: { scopes?: readonly string[] } = {}): Promise<TokenSet> {
    const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
    if (options.scopes?.length) form.scope = options.scopes.join(" ");
    return tokensFrom(await this.#send(this.tokenRequest(form)));
  }

  /** Disconnect the installation (RFC 7009): either half of a pair revokes both. */
  async revoke(token: string): Promise<void> {
    const answer = await this.#send(this.tokenRequest({ token }, "/oauth/revoke"));
    if (answer.status < 200 || answer.status >= 300) throw failure(answer);
  }
}

/** What `AsyncLocalStorage` offers, where the runtime has it (Node, Bun, Deno). */
interface CallContext {
  run<R>(store: unknown, callback: () => R): R;
  getStore(): unknown;
}

// Marks the code `onTokenRefresh` runs, so that a request it makes on the same
// client raises instead of waiting forever on the renewal that called it.
// Without `AsyncLocalStorage` (a browser, Workers without node compatibility)
// such a request still waits, as the README warns.
const inCallback: CallContext | null = (() => {
  try {
    const runtime = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const hooks = runtime?.getBuiltinModule?.("node:async_hooks") as
      | { AsyncLocalStorage?: new () => CallContext }
      | undefined;
    return hooks?.AsyncLocalStorage ? new hooks.AsyncLocalStorage() : null;
  } catch {
    return null;
  }
})();

const REENTRY =
  "This Talki is renewing its token: do not make a request on it from onTokenRefresh. " +
  "Store the pair and return; send the request after.";

/** A lock whose holders take turns, first come first served. */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.#tail;
    this.#tail = before.then(() => held);
    await before;
    return release;
  }
}

/**
 * Sends the current access token, and renews the pair shortly before it
 * expires, or when the API answers that it has. `new Talki({ tokens, oauthApp })`
 * builds one, which its `withOptions` copies share.
 *
 * One lock serialises every renewal: presenting a rotated refresh token again
 * revokes the installation.
 *
 * A refresh whose outcome is unknown (its answer lost, timed out, or a
 * gateway's 502, 503 or 504) may have rotated the pair on the server. The
 * same refresh token is presented again `REFRESH_SETTLE` seconds later, so as
 * not to overlap the first, within the same request as long as that is
 * inside the server's `REFRESH_GRACE`; otherwise on the next request, which
 * takes it only if nothing reached the server the first time.
 */
export class TokenRefresh {
  #tokens: TokenSet;
  readonly #app: OAuthApp;
  readonly #onRefresh: ((tokens: TokenSet) => void | Promise<void>) | undefined;
  readonly #leeway: number;
  readonly #log: Log;
  readonly #lock = new Mutex();
  // On a clock that never steps back, in seconds: when the last refresh was
  // sent; when a refresh's outcome last became unknown; and when the first
  // refresh still of unknown outcome was sent, which is before the server
  // could have rotated the pair and started its grace.
  readonly #monotonic: () => number;
  readonly #clock: () => number;
  readonly #sleep: (seconds: number) => Promise<void>;
  #sentAt = 0;
  #inDoubtSince: number | null = null;
  #doubtSent: number | null = null;
  // A pair the API issued that could not be stored yet: the only live one.
  #pending: TokenSet | null = null;
  // Set once the API refused the refresh token or the app's credentials:
  // every request fails fast, without spending the token endpoint's limits.
  #dead: OAuthError | null = null;

  constructor(
    tokens: TokenSet,
    app: OAuthApp,
    options: {
      onRefresh?: ((tokens: TokenSet) => void | Promise<void>) | undefined;
      leeway?: number;
      log?: Log;
      hooks?: Hooks | undefined;
    } = {},
  ) {
    this.#tokens = tokens;
    this.#app = app;
    this.#onRefresh = options.onRefresh;
    this.#leeway = options.leeway ?? REFRESH_LEEWAY;
    this.#log = options.log ?? SILENT;
    this.#monotonic = options.hooks?.monotonic ?? monotonic;
    this.#clock = options.hooks?.clock ?? Date.now;
    this.#sleep = options.hooks?.renewalSleep ?? sleep;
  }

  /** The pair in use. A new one waiting to be stored is not in use yet. */
  get tokens(): TokenSet {
    return this.#tokens;
  }

  // Decisions, under the lock.

  #due(): boolean {
    const expiresAt = this.#tokens.expiresAt;
    return this.#pending !== null || (expiresAt !== null && this.#clock() >= expiresAt - this.#leeway * 1000);
  }

  /**
   * Under the lock: store a pair still pending, and say whether to refresh:
   * when the pair is due, or, for a request the API answered that its token
   * expired, when no one renewed it meanwhile.
   */
  async #wanted(retry: boolean, sent: string | null): Promise<boolean> {
    this.#check();
    if (this.#pending !== null) {
      await this.#store(this.#pending);
      return false;
    }
    return retry ? this.#tokens.accessToken === sent : this.#due();
  }

  static #rejected(answer: Answer): boolean {
    return answer.status === 401 && (answer.headers.get("WWW-Authenticate") ?? "").includes('error="invalid_token"');
  }

  /**
   * The refresh to send now, with the caller's timeout and nothing else of
   * its request: not its signal either, so that a caller giving up never
   * abandons a rotation half way, with its outcome unknown.
   */
  #presentation(request: OutgoingRequest): OutgoingRequest {
    const refresh = this.#app.tokenRequest(
      { grant_type: "refresh_token", refresh_token: this.#tokens.refreshToken },
      "/oauth/token",
      request.timeout,
    );
    refresh.unsentOnly = true;
    this.#sentAt = this.#monotonic();
    return refresh;
  }

  /**
   * How long to wait before presenting a refresh token whose last
   * presentation has an unknown outcome: timed from when the outcome was
   * lost, since a timeout comes long after the send.
   */
  #settleDelay(): number {
    if (this.#inDoubtSince === null) return 0;
    return Math.max(0, REFRESH_SETTLE - (this.#monotonic() - this.#inDoubtSince));
  }

  /**
   * Record a refresh that ended in ``error``, or (null) in a gateway's 5xx,
   * and say whether to present it again in this request, after the settle.
   */
  #lost(error: unknown): boolean {
    if (error instanceof ConnectionError && !error.sent) {
      // Nothing reached the server: as much in doubt as before.
      return false;
    }
    const now = this.#monotonic();
    this.#inDoubtSince = now;
    this.#doubtSent ??= this.#sentAt;
    const cause = error === null ? "a gateway error" : error instanceof Error ? error.name : "an error";
    if (error !== null && !(error instanceof ConnectionError)) {
      // A failure that is not the network's: not one to repeat here.
      this.#log.warn(`A token renewal ended in ${cause}, its outcome unknown; the next request presents it again.`);
      return false;
    }
    const again = now + REFRESH_SETTLE <= this.#doubtSent + REFRESH_GRACE - GRACE_MARGIN;
    this.#log.warn(
      `A token renewal ended in ${cause}, its outcome unknown; ${
        again ? `presenting it again in ${REFRESH_SETTLE} s` : "the next request presents it again"
      }.`,
    );
    return again;
  }

  /**
   * Apply a refresh's answer, or say (false) to present it again. A gateway's
   * 502, 503 or 504 does not say whether the refresh ran: the app may have
   * rotated the pair and then died.
   */
  async #answered(answer: Answer): Promise<boolean> {
    if (GATEWAY_STATUSES.has(answer.status)) {
      if (this.#lost(null)) return false;
      throw failure(answer);
    }
    this.#inDoubtSince = null;
    this.#doubtSent = null;
    await this.#apply(answer);
    return true;
  }

  /**
   * Hand the pair to `onRefresh`, then use it. If storing fails it stays
   * pending: the next request stores it first, never refreshing again with
   * the refresh token it replaced.
   */
  async #store(renewed: TokenSet): Promise<void> {
    this.#pending = renewed;
    const onRefresh = this.#onRefresh;
    if (onRefresh) {
      await (inCallback ? inCallback.run(this, () => onRefresh(renewed)) : onRefresh(renewed));
    }
    this.#tokens = renewed;
    this.#pending = null;
    this.#log.info(`Renewed the access token of installation ${renewed.installationId || "(unnamed)"}.`);
  }

  async #apply(answer: Answer): Promise<void> {
    let renewed: TokenSet;
    try {
      renewed = tokensFrom(answer, this.#clock());
    } catch (error) {
      if (error instanceof OAuthError && (error.error === "invalid_grant" || error.error === "invalid_client")) {
        this.#log.error(
          `The API refused the token renewal (${error.error}): ${
            error.error === "invalid_grant"
              ? "the customer has to reconnect the app"
              : "check the app's client ID and secret"
          }`,
        );
        this.#dead = error;
      }
      throw error;
    }
    await this.#store(renewed);
  }

  #check(): void {
    const dead = this.#dead;
    if (dead !== null) {
      // A new error each time, with this caller's stack.
      throw new OAuthError(dead.error, dead.description, { status: dead.status, requestId: dead.requestId });
    }
  }

  /** Under the lock: present the refresh token until an answer settles it. */
  async #refresh(request: OutgoingRequest, transport: Transport): Promise<void> {
    while (true) {
      const delay = this.#settleDelay();
      if (delay > 0) await this.#sleep(delay);
      const refresh = this.#presentation(request);
      let answer: Answer;
      try {
        answer = await transport.send(refresh);
      } catch (error) {
        if (this.#lost(error)) continue;
        throw error;
      }
      if (await this.#answered(answer)) return;
    }
  }

  /**
   * Send ``request`` on ``transport`` with the current access token, renewing
   * the pair first when it is due, and once more when the API answers that
   * the token has expired.
   */
  async send(request: OutgoingRequest, transport: Transport): Promise<Answer> {
    if (inCallback?.getStore() === this) throw new Error(REENTRY);
    this.#check();
    let sent: string | null = null;
    for (const retry of [false, true]) {
      if (retry || this.#due()) {
        const release = await this.#lock.acquire();
        try {
          if (await this.#wanted(retry, sent)) await this.#refresh(request, transport);
        } finally {
          release();
        }
      }
      sent = this.#tokens.accessToken;
      request.headers.set("Authorization", `Bearer ${sent}`);
      const answer = await transport.send(request);
      if (retry || !TokenRefresh.#rejected(answer)) return answer;
    }
    throw new Error("unreachable");
  }
}
