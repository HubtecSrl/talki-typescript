/**
 * What the client throws: one class per error `type` of the API's envelope,
 * so a caller can catch the kind of failure it handles.
 *
 * Branch on `code` within a class; the message is for people. An answer with
 * no envelope (a proxy's 502, an undeclared status) throws the class its HTTP
 * status implies, with `code` and `type` null.
 */

export const REQUEST_ID_HEADER = "X-Request-Id";

/** Every error this package throws on purpose. */
export class TalkiError extends Error {
  override name = "TalkiError";
}

export interface ApiErrorInit {
  status: number;
  code?: string | null;
  type?: string | null;
  message?: string;
  requestId?: string | null;
  headers?: Headers;
  body?: string;
}

/** The API refused the request, or answered in a way this client cannot read. */
export class ApiError extends TalkiError {
  override name = "ApiError";
  /** The HTTP status. */
  readonly status: number;
  /** The envelope's `error.code`: what to branch on. Null without an envelope. */
  readonly code: string | null;
  /** The envelope's `error.type`. Null without an envelope. */
  readonly type: string | null;
  /** The API's own message, for people (`message` adds the status and code to it). */
  readonly apiMessage: string;
  /** The `X-Request-Id` to quote to Talki about this request. */
  readonly requestId: string | null;
  readonly headers: Headers;
  /** The answer's body as text. */
  readonly body: string;

  constructor(init: ApiErrorInit) {
    const code = init.code ?? null;
    const apiMessage = init.message ?? "";
    const requestId = init.requestId ?? null;
    let text = `HTTP ${init.status} ${code ?? "unexpected_response"}`;
    if (apiMessage) text += `: ${apiMessage}`;
    if (requestId) text += ` (request ${requestId})`;
    super(text);
    this.status = init.status;
    this.code = code;
    this.type = init.type ?? null;
    this.apiMessage = apiMessage;
    this.requestId = requestId;
    this.headers = init.headers ?? new Headers();
    this.body = init.body ?? "";
  }
}

/** `invalid_request`: fix the request; retrying it unchanged fails again. */
export class InvalidRequestError extends ApiError {
  override name = "InvalidRequestError";
}

/** `authentication_error`: the credential is missing, wrong, expired or revoked. */
export class AuthenticationError extends ApiError {
  override name = "AuthenticationError";
}

/** `permission_error`: the credential is valid but may not do this. */
export class PermissionDeniedError extends ApiError {
  override name = "PermissionDeniedError";
}

/** `conflict`: the request clashes with the resource's current state. */
export class ConflictError extends ApiError {
  override name = "ConflictError";
}

/** `rate_limit_error`: too many requests. */
export class RateLimitError extends ApiError {
  override name = "RateLimitError";

  /** The wait the API asked for, in seconds (`Retry-After`), or null when it did not say. */
  get retryAfter(): number | null {
    return retryAfterSeconds(this.headers);
  }
}

/** `api_error`, or a 5xx with no envelope: the failure is on Talki's side. */
export class ServerError extends ApiError {
  override name = "ServerError";
}

/**
 * The request failed before an answer arrived: the connection could not be
 * made, or broke. `sent` is false only when the request is known never to
 * have left; otherwise it may have reached the API.
 */
export class ConnectionError extends TalkiError {
  override name = "ConnectionError";
  /** False when the request certainly never reached the API. */
  readonly sent: boolean;
  /** The `Idempotency-Key` the request carried: send a write again with it once you know what happened. */
  readonly idempotencyKey: string | null;

  constructor(message: string, options: { sent: boolean; idempotencyKey?: string | null; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.sent = options.sent;
    this.idempotencyKey = options.idempotencyKey ?? null;
  }
}

/** No answer within the client's `timeout`. The request may have reached the API. */
export class RequestTimeoutError extends ConnectionError {
  override name = "RequestTimeoutError";
}

type ApiErrorClass = new (init: ApiErrorInit) => ApiError;

const BY_TYPE: Record<string, ApiErrorClass> = {
  invalid_request: InvalidRequestError,
  authentication_error: AuthenticationError,
  permission_error: PermissionDeniedError,
  conflict: ConflictError,
  rate_limit_error: RateLimitError,
  api_error: ServerError,
};

const BY_STATUS: Record<number, ApiErrorClass> = {
  400: InvalidRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  409: ConflictError,
  429: RateLimitError,
};

function classFor(type: string | null, status: number): ApiErrorClass {
  if (type !== null) {
    // A type this client predates: the base class, which every caller catches.
    return Object.hasOwn(BY_TYPE, type) ? (BY_TYPE[type] as ApiErrorClass) : ApiError;
  }
  if (status >= 500) return ServerError;
  return BY_STATUS[status] ?? ApiError;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error for one answer, read from its envelope when it has one. */
export function errorFrom(status: number, headers: Headers, body: string): ApiError {
  let payload: unknown = null;
  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
  }
  const detail = isObject(payload) ? payload.error : null;
  if (isObject(detail)) {
    const type = text(detail.type);
    const Class = classFor(type, status);
    return new Class({
      status,
      code: text(detail.code),
      type,
      message: detail.message == null ? "" : String(detail.message),
      requestId: text(detail.request_id) || headers.get(REQUEST_ID_HEADER),
      headers,
      body,
    });
  }
  const Class = classFor(null, status);
  return new Class({
    status,
    message: body.slice(0, 300),
    requestId: headers.get(REQUEST_ID_HEADER),
    headers,
    body,
  });
}

/** `Retry-After` as seconds from now: it may be a number or an HTTP date. */
export function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (raw.trim() !== "" && !Number.isNaN(seconds)) return Math.max(0, seconds);
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, (when - Date.now()) / 1000);
}
