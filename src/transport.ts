/**
 * The transport every request goes out on: it adds an `Idempotency-Key` to a
 * write that has none, and retries what is safe to retry.
 *
 * Retried, at most `maxRetries` times:
 * - any request that never left (the connection was refused or never made);
 * - any request answered 429 or `409 request_in_progress`: the API turned it
 *   away before running it;
 * - a `GET`, `HEAD` or `OPTIONS` answered 500, 502, 503 or 504, or whose
 *   connection broke or timed out after sending;
 * - a write carrying an `Idempotency-Key` answered 502, 503 or 504 by a
 *   gateway (a body that is not the API's error envelope). The API answers a
 *   repeated key with the first answer, or `request_in_progress` while that
 *   one runs.
 *
 * Never retried: a write answered 5xx by the API itself, or whose connection
 * broke or timed out after sending, since either may come after the write was
 * saved. Its key keeps a repeat from applying it twice: the API answers the
 * key of a write that saved and then failed with that same 500 for 24 hours,
 * and releases a key only when nothing was saved. Read the resource to learn
 * which happened; to retry, use the key sent (`ConnectionError.idempotencyKey`).
 *
 * A request marked `unsentOnly` (a token refresh) is retried only when it
 * never left, or was turned away unrun (429, `request_in_progress`): once it
 * may have reached the API, the one who sent it decides when to send it again.
 *
 * The wait is the answer's `Retry-After` when it gives one, else exponential
 * backoff with jitter. An answer asking for more than `MAX_RETRY_AFTER`
 * seconds is returned as is, for the caller to schedule.
 */

import { ConnectionError, REQUEST_ID_HEADER, RequestTimeoutError, retryAfterSeconds } from "./errors.js";
import { type Log, SILENT } from "./logging.js";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SAFE_RETRY_STATUSES = new Set([500, 502, 503, 504]);
export const GATEWAY_STATUSES = new Set([502, 503, 504]);
export const MAX_RETRY_AFTER = 60;
const BACKOFF_BASE = 0.5;
const BACKOFF_CAP = 8;

// Error codes, at any depth of an error's `cause`, that mean the connection
// was never made, so nothing reached the API. Anything else may have.
const NOT_SENT_CODES = new Set([
  // Node (undici) and Deno's Node layer.
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  // Bun.
  "ConnectionRefused",
  "FailedToOpenSocket",
]);
// Deno's own fetch says so only in its message.
const NOT_SENT_MESSAGE = /\btcp connect error\b|\bdns error\b|\bConnection refused\b/i;

/** A fresh `Idempotency-Key`: keep it to send a write again as the same one. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** A request as the transport sends it: the body is text, so it can be sent again. */
export interface OutgoingRequest {
  method: string;
  url: string;
  headers: Headers;
  body?: string;
  /** Milliseconds each attempt may take, answer body included. */
  timeout: number;
  signal?: AbortSignal | undefined;
  /** Retry only when it never left, or was turned away unrun. */
  unsentOnly?: boolean;
}

/** An answer, its body read whole. */
export interface Answer {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/** What tests replace: the clocks and the waits. */
export interface Hooks {
  /** Waits ``seconds`` between retries. */
  sleep?: (seconds: number, signal?: AbortSignal) => Promise<void>;
  /** Waits ``seconds`` before a token refresh is presented again. */
  renewalSleep?: (seconds: number) => Promise<void>;
  /** A number in [0, 1). */
  jitter?: () => number;
  /** A clock in seconds that never steps back. */
  monotonic?: () => number;
  /** The wall clock, in milliseconds since the epoch. */
  clock?: () => number;
}

export function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, seconds * 1000);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function monotonic(): number {
  return performance.now() / 1000;
}

function key(headers: Headers): string {
  return (headers.get(IDEMPOTENCY_HEADER) ?? "").trim();
}

/** The `error.code` of an answer, "" when it is not a string, or null when the body is not the API's JSON envelope. */
export function envelopeCode(answer: Answer): string | null {
  if (!(answer.headers.get("content-type") ?? "").includes("json")) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(answer.body));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const detail = (payload as Record<string, unknown>).error;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const code = (detail as Record<string, unknown>).code;
  return typeof code === "string" ? code : "";
}

/** An error and its causes, outermost first. */
function chain(error: unknown): Array<{ code?: unknown; message?: unknown; errors?: unknown }> {
  const found: Array<{ code?: unknown; message?: unknown; errors?: unknown }> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    found.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

/** Whether a failed fetch certainly never reached the server. */
export function neverSent(error: unknown): boolean {
  return chain(error).some((each) => {
    const nested = Array.isArray(each.errors) ? (each.errors as Array<{ code?: unknown }>) : [];
    return (
      [each, ...nested].some((one) => typeof one.code === "string" && NOT_SENT_CODES.has(one.code)) ||
      (typeof each.message === "string" && NOT_SENT_MESSAGE.test(each.message))
    );
  });
}

class Timeout extends Error {}

export class Transport {
  readonly maxRetries: number;
  readonly autoIdempotency: boolean;
  readonly #fetch: Fetch;
  readonly #log: Log;
  readonly #sleep: (seconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #jitter: () => number;

  constructor(options: {
    fetch: Fetch;
    maxRetries?: number;
    autoIdempotency?: boolean;
    log?: Log;
    hooks?: Hooks | undefined;
  }) {
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("maxRetries must be a whole number, 0 or more.");
    }
    this.maxRetries = maxRetries;
    this.autoIdempotency = options.autoIdempotency ?? true;
    this.#fetch = options.fetch;
    this.#log = options.log ?? SILENT;
    this.#sleep = options.hooks?.sleep ?? sleep;
    this.#jitter = options.hooks?.jitter ?? Math.random;
  }

  /** A copy that retries ``maxRetries`` times. */
  withRetries(maxRetries: number): Transport {
    return new Transport({
      fetch: this.#fetch,
      maxRetries,
      autoIdempotency: this.autoIdempotency,
      log: this.#log,
      hooks: { sleep: this.#sleep, jitter: this.#jitter },
    });
  }

  get log(): Log {
    return this.#log;
  }

  /** The request, before its first attempt. */
  #prepare(request: OutgoingRequest): void {
    if (request.headers.has(IDEMPOTENCY_HEADER) && !key(request.headers)) {
      // The API reads a blank key as none: send none, or a real one.
      request.headers.delete(IDEMPOTENCY_HEADER);
    }
    if (this.autoIdempotency && WRITE_METHODS.has(request.method) && !key(request.headers)) {
      request.headers.set(IDEMPOTENCY_HEADER, newIdempotencyKey());
    }
  }

  #backoff(attempt: number): number {
    return Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** attempt) * (0.5 + this.#jitter() / 2);
  }

  #retryable(request: OutgoingRequest, answer: Answer): boolean {
    const status = answer.status;
    if (status === 429) return true;
    if (status === 409) return envelopeCode(answer) === "request_in_progress";
    if (SAFE_METHODS.has(request.method)) return SAFE_RETRY_STATUSES.has(status);
    return (
      GATEWAY_STATUSES.has(status) &&
      !request.unsentOnly &&
      key(request.headers) !== "" &&
      envelopeCode(answer) === null
    );
  }

  #delay(request: OutgoingRequest, answer: Answer, attempt: number): number | null {
    if (attempt >= this.maxRetries || !this.#retryable(request, answer)) return null;
    const asked = retryAfterSeconds(answer.headers);
    if (asked === null) return this.#backoff(attempt);
    return asked <= MAX_RETRY_AFTER ? asked : null;
  }

  #afterError(request: OutgoingRequest, error: ConnectionError, attempt: number): number | null {
    if (attempt >= this.maxRetries) return null;
    // What may have arrived is sent again only when it reads.
    if (!error.sent || SAFE_METHODS.has(request.method)) return this.#backoff(attempt);
    return null;
  }

  /** One attempt: the answer with its body read, or the error to decide on. */
  async #attempt(request: OutgoingRequest): Promise<Answer> {
    const caller = request.signal;
    caller?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(caller?.reason);
    caller?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Timeout()), request.timeout);
    try {
      const response = await this.#fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
        // As the API answers: a redirect is not followed, so a write is never
        // sent again as something else.
        redirect: "manual",
      });
      const body = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (caller?.aborted) throw caller.reason;
      const idempotencyKey = key(request.headers) || null;
      if (controller.signal.reason instanceof Timeout) {
        throw new RequestTimeoutError(`No answer within ${request.timeout} ms.`, {
          sent: true,
          idempotencyKey,
          cause: error,
        });
      }
      const sent = !neverSent(error);
      const what = error instanceof Error ? error.message : String(error);
      throw new ConnectionError(sent ? `The connection failed: ${what}` : `Could not connect: ${what}`, {
        sent,
        idempotencyKey,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
    }
  }

  async send(request: OutgoingRequest): Promise<Answer> {
    this.#prepare(request);
    const path = new URL(request.url).pathname;
    for (let attempt = 0; ; attempt++) {
      const started = monotonic();
      let delay: number | null;
      try {
        const answer = await this.#attempt(request);
        delay = this.#delay(request, answer, attempt);
        if (delay === null) {
          this.#log.debug(() => `${request.method} ${path}: ${describe(answer)} in ${elapsed(started)} ms`);
          return answer;
        }
        this.#logRetry(request.method, path, describe(answer), delay, attempt);
      } catch (error) {
        if (!(error instanceof ConnectionError)) throw error;
        delay = this.#afterError(request, error, attempt);
        if (delay === null) {
          this.#log.debug(() => `${request.method} ${path}: ${error.name} after ${elapsed(started)} ms`);
          throw error;
        }
        this.#logRetry(request.method, path, error.name, delay, attempt);
      }
      await this.#sleep(delay, request.signal);
    }
  }

  #logRetry(method: string, path: string, outcome: string, delay: number, attempt: number): void {
    this.#log.info(
      `${method} ${path}: ${outcome}; retry ${attempt + 1} of ${this.maxRetries} in ${delay.toFixed(1)} s`,
    );
  }
}

/** A status and, when the API gave one, the request ID to quote to Talki. */
function describe(answer: Answer): string {
  const requestId = answer.headers.get(REQUEST_ID_HEADER);
  return requestId ? `${answer.status}, request ${requestId}` : String(answer.status);
}

function elapsed(started: number): string {
  return ((monotonic() - started) * 1000).toFixed(0);
}
