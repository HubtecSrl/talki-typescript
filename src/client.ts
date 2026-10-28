/**
 * `Talki`, the client to start from.
 *
 *     import { Talki } from "@hubtec/talki";
 *
 *     const talki = new Talki({ apiKey: "talki_test_…" });
 *     const account = await talki.account.get();
 *     for await (const call of talki.calls.list({ limit: 100 })) { … }
 *
 * Each method returns the operation's value or throws the `ApiError`
 * subclass for its error. `talki.withOptions({ timeout, maxRetries })` is the
 * same client with other settings, for the calls made on it.
 * `talki.<resource>.withRawResponse` has the same methods, returning the
 * status and headers (`ETag`, `X-Request-Id`, …) with the value.
 */

import { Core, VERSION_HEADER } from "./core.js";
import { API_VERSION } from "./generated/api-version.js";
import { Resources } from "./generated/resources.js";
import { Log, type Logger, type LogLevel } from "./logging.js";
import { type OAuthApp, TokenRefresh, type TokenSet } from "./oauth.js";
import { type Fetch, type Hooks, Transport } from "./transport.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.talki.it";
/** Read for `apiKey` when no credential is passed. */
export const API_KEY_ENV = "TALKI_API_KEY";

/** Test hooks, under a key no caller's options can hold by chance. */
export const HOOKS: unique symbol = Symbol("talki.hooks");
const SHARED: unique symbol = Symbol("talki.shared");

export interface TalkiOptions {
  /**
   * A business's API key (`talki_live_…`, or `talki_test_…` for a sandbox).
   * With no credential passed at all, it is read from the `TALKI_API_KEY`
   * environment variable where `process.env` exists.
   */
  apiKey?: string;
  /** An OAuth installation's access token (`talki_at_…`), when not using an API key. */
  accessToken?: string;
  /**
   * An installation's whole pair, instead of `accessToken`. With `oauthApp`
   * the pair renews itself: before it expires, and when the API answers that
   * it has. Exactly one of `apiKey`, `accessToken` and `tokens` is required.
   */
  tokens?: TokenSet;
  /** The app's credentials, to renew `tokens`. */
  oauthApp?: OAuthApp;
  /**
   * Called with each new pair, before it is used: store it there, and the
   * request waits until you have. The previous refresh token stops working.
   * Only with `oauthApp`.
   */
  onTokenRefresh?: (tokens: TokenSet) => void | Promise<void>;
  /**
   * The `Talki-Version` sent on every request. Defaults to `API_VERSION`, the
   * contract this package was generated from; null sends none, and the
   * version pinned on the key or app applies.
   */
  version?: string | null;
  /** The API's origin. */
  baseUrl?: string;
  /** Milliseconds each attempt may take, answer included. Defaults to 30 000. */
  timeout?: number;
  /** How often a failed request is tried again; 0 for never. Defaults to 2. */
  maxRetries?: number;
  /**
   * Give every write without an `Idempotency-Key` a new one. Pass
   * `idempotencyKey` to a method to choose your own, for instance to retry a
   * write across process restarts. Defaults to true.
   */
  autoIdempotency?: boolean;
  /** The `fetch` requests go out on: the global one by default. */
  fetch?: Fetch;
  /**
   * Your product and version (`acme-crm/2.1`), added after this package's
   * own in the `User-Agent` of every API request. A token renewal carries
   * this package's alone.
   */
  userAgent?: string;
  /** Where to log, `console` by default. Nothing is logged unless `logLevel` is set. */
  logger?: Logger;
  /** What to log; `"off"`, the default, logs nothing. */
  logLevel?: LogLevel;
}

interface Internal {
  [HOOKS]?: Hooks;
  [SHARED]?: Core;
}

function runtime(): string {
  const scope = globalThis as {
    Bun?: { version?: string };
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { node?: string } };
    navigator?: { userAgent?: string };
  };
  if (scope.Bun?.version) return `bun/${scope.Bun.version}`;
  if (scope.Deno?.version?.deno) return `deno/${scope.Deno.version.deno}`;
  if (scope.process?.versions?.node) return `node/${scope.process.versions.node}`;
  if (scope.navigator?.userAgent === "Cloudflare-Workers") return "cloudflare-workers";
  return "js";
}

/** The `User-Agent` of every API request: this package, its version and the runtime's. */
export const USER_AGENT = `talki-typescript/${VERSION} ${runtime()}`;

function environmentKey(): string | undefined {
  const scope = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const value = scope.process?.env?.[API_KEY_ENV]?.trim();
  return value || undefined;
}

function coreFrom(options: TalkiOptions & Internal): Core {
  let { apiKey } = options;
  const { accessToken, tokens, oauthApp, onTokenRefresh, userAgent } = options;
  if (apiKey == null && accessToken == null && tokens == null) apiKey = environmentKey();
  const given = [apiKey, accessToken, tokens].filter((value) => value != null);
  if (given.length !== 1) {
    throw new TypeError(`Pass exactly one of apiKey, accessToken and tokens, or set ${API_KEY_ENV}.`);
  }
  if (oauthApp != null && tokens == null) throw new TypeError("oauthApp renews tokens: pass tokens too.");
  if (onTokenRefresh != null && oauthApp == null) {
    throw new TypeError("onTokenRefresh is called when tokens renew, which takes oauthApp: pass it too.");
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (oauthApp != null && oauthApp.baseUrl !== baseUrl) {
    // A staging pair renewed against production would send the refresh token
    // and the client secret to the wrong deployment.
    throw new TypeError(`oauthApp talks to ${oauthApp.baseUrl}, this client to ${baseUrl}: make them the same.`);
  }
  if (userAgent !== undefined && !/^[\x20-\x7e]*[\x21-\x7e][\x20-\x7e]*$/.test(userAgent)) {
    throw new TypeError("userAgent must be one non-blank line of printable ASCII.");
  }
  const timeout = options.timeout ?? 30_000;
  if (!(timeout > 0)) throw new RangeError("timeout must be a number of milliseconds above 0.");
  const hooks = options[HOOKS];
  const log = new Log(options.logger, options.logLevel);
  const transport = new Transport({
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    maxRetries: options.maxRetries ?? 2,
    autoIdempotency: options.autoIdempotency ?? true,
    log,
    hooks,
  });
  return new Core({
    baseUrl,
    version: options.version === undefined ? API_VERSION : options.version,
    userAgent: userAgent ? `${USER_AGENT} ${userAgent.trim()}` : USER_AGENT,
    timeout,
    token: tokens != null ? tokens.accessToken : String(given[0]),
    tokens: tokens ?? null,
    transport,
    auth:
      tokens != null && oauthApp != null
        ? new TokenRefresh(tokens, oauthApp, { onRefresh: onTokenRefresh, log, hooks })
        : null,
  });
}

/**
 * A client for Talki's public API. One attribute per resource of the API
 * reference (`talki.account`, `talki.calls`, …), one method per operation.
 *
 * Keep one for the life of the process: it holds no connection of its own
 * and needs no closing.
 */
export class Talki extends Resources {
  readonly #core: Core;

  constructor(options: TalkiOptions = {}) {
    const core = (options as Internal)[SHARED] ?? coreFrom(options);
    super(core);
    this.#core = core;
  }

  /**
   * This client with another `timeout` or `maxRetries`, for the calls made on
   * what it returns: `talki.withOptions({ timeout: 5000 }).calls.get(id)`.
   * The copy shares this client's token renewal, so it is cheap to make for
   * one call.
   */
  withOptions(options: { timeout?: number; maxRetries?: number }): Talki {
    if (options.timeout !== undefined && !(options.timeout > 0)) {
      throw new RangeError("timeout must be a number of milliseconds above 0.");
    }
    return new Talki({ [SHARED]: this.#core.with(options) } as TalkiOptions);
  }

  /** The `Talki-Version` this client sends, or null when it sends none. */
  get version(): string | null {
    return this.#core.settings.version;
  }

  get baseUrl(): string {
    return this.#core.settings.baseUrl;
  }

  /** The pair in use, when built with `tokens` (renewed in place); null otherwise. */
  get tokens(): TokenSet | null {
    return this.#core.settings.auth?.tokens ?? this.#core.settings.tokens;
  }

  get [Symbol.toStringTag](): string {
    return "Talki";
  }
}

export { VERSION_HEADER };
