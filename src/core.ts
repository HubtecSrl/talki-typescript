/**
 * What the generated resource classes send their requests through: an
 * operation's descriptor and arguments in, a `RawResponse` (or the
 * `ApiError` for an error) out.
 */

import { ApiError, errorFrom, REQUEST_ID_HEADER } from "./errors.js";
import type { TokenRefresh, TokenSet } from "./oauth.js";
import { type ListBody, Page } from "./pagination.js";
import type { Answer, OutgoingRequest, Transport } from "./transport.js";

export const VERSION_HEADER = "Talki-Version";

/** Options every method takes, after its path parameters. */
export interface RequestOptions {
  /** Aborts the request, its retries and the waits between them. */
  signal?: AbortSignal | undefined;
  /** The `Talki-Version` for this one request, instead of the client's. */
  talkiVersion?: string | undefined;
}

/** One operation of the API, as the generator describes it. */
export interface Operation {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The path, with `{name}` for each path parameter, in order. */
  readonly path: string;
  /** The query parameters' names, as the API spells them. */
  readonly query: readonly string[];
  /** Header parameters: the option's name, then the header's. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: "required" | "optional" | null;
  /** The success statuses the operation declares. */
  readonly success: readonly number[];
  /** Whether a success is a file (a PDF, a spreadsheet, audio) rather than JSON. */
  readonly binary: boolean;
}

/**
 * A successful answer, as `talki.<resource>.withRawResponse.<method>()`
 * returns it: the status, the headers (`ETag`, `Idempotency-Replayed`, the
 * rate limits) and `data`, the value the method itself returns.
 */
export interface RawResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  /** The `X-Request-Id` to quote to Talki about this request. */
  readonly requestId: string | null;
  readonly data: T;
}

/** What a generated resource needs from the client. */
export interface Requester {
  request<T>(operation: Operation, path: readonly string[], params: object): Promise<RawResponse<T>>;
  requestPage<T>(operation: Operation, path: readonly string[], params: object): Promise<RawResponse<Page<T>>>;
}

export interface CoreSettings {
  baseUrl: string;
  version: string | null;
  userAgent: string;
  timeout: number;
  token: string;
  /** The pair passed as `tokens`, when it does not renew itself. */
  tokens: TokenSet | null;
  transport: Transport;
  auth: TokenRefresh | null;
}

function queryValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const decoder = new TextDecoder();

/** The settings of one client, shared by the resources it hands out. */
export class Core implements Requester {
  readonly settings: Readonly<CoreSettings>;

  constructor(settings: CoreSettings) {
    this.settings = settings;
  }

  /** This client with another timeout or retry count, sharing its token renewal. */
  with(options: { timeout?: number | undefined; maxRetries?: number | undefined }): Core {
    const { settings } = this;
    return new Core({
      ...settings,
      timeout: options.timeout ?? settings.timeout,
      transport:
        options.maxRetries === undefined ? settings.transport : settings.transport.withRetries(options.maxRetries),
    });
  }

  #build(operation: Operation, path: readonly string[], params: Record<string, unknown>): OutgoingRequest {
    const { settings } = this;
    let index = 0;
    const filled = operation.path.replace(/\{[^}]+\}/g, () => {
      const value = path[index++];
      if (value === undefined || value === null || value === "") {
        throw new TypeError(`${operation.method} ${operation.path} needs every path parameter.`);
      }
      return encodeURIComponent(String(value));
    });
    const search = new URLSearchParams();
    for (const name of operation.query) {
      const value = params[name];
      if (value === undefined || value === null) continue;
      for (const each of Array.isArray(value) ? value : [value]) search.append(name, queryValue(each));
    }
    const encoded = search.toString();
    const query = encoded ? `?${encoded}` : "";

    const headers = new Headers({ "User-Agent": settings.userAgent });
    const version = typeof params.talkiVersion === "string" ? params.talkiVersion : settings.version;
    if (version) headers.set(VERSION_HEADER, version);
    for (const [option, header] of Object.entries(operation.headers)) {
      const value = params[option];
      if (typeof value === "string") headers.set(header, value);
    }
    let body: string | undefined;
    if (operation.body !== null && params.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(params.body);
    } else if (operation.body === "required") {
      throw new TypeError(`${operation.method} ${operation.path} needs a body.`);
    }
    const signal = params.signal instanceof AbortSignal ? params.signal : undefined;
    return {
      method: operation.method,
      url: `${settings.baseUrl}${filled}${query}`,
      headers,
      ...(body === undefined ? {} : { body }),
      timeout: settings.timeout,
      signal,
    };
  }

  async #send(request: OutgoingRequest): Promise<Answer> {
    const { auth, transport, token } = this.settings;
    if (auth !== null) return auth.send(request, transport);
    request.headers.set("Authorization", `Bearer ${token}`);
    return transport.send(request);
  }

  async request<T>(operation: Operation, path: readonly string[], params: object): Promise<RawResponse<T>> {
    const answer = await this.#send(this.#build(operation, path, params as Record<string, unknown>));
    return {
      status: answer.status,
      headers: answer.headers,
      requestId: answer.headers.get(REQUEST_ID_HEADER),
      data: read<T>(operation, answer),
    };
  }

  async requestPage<T>(operation: Operation, path: readonly string[], params: object): Promise<RawResponse<Page<T>>> {
    const raw = await this.request<ListBody<T>>(operation, path, params);
    const fetch = async (cursor: string): Promise<Page<T>> =>
      (await this.requestPage<T>(operation, path, { ...params, cursor })).data;
    const cursor = (params as { cursor?: unknown }).cursor;
    return { ...raw, data: new Page<T>(raw.data, fetch, typeof cursor === "string" ? cursor : null) };
  }
}

/**
 * The value of an answer, or the `ApiError` subclass for its error. A
 * success this client cannot read (a status the operation does not declare,
 * a body that is not the JSON it declares) throws `ApiError` too.
 */
function read<T>(operation: Operation, answer: Answer): T {
  const { status, headers, body } = answer;
  if (status >= 400) throw errorFrom(status, headers, decoder.decode(body));
  if (!operation.success.includes(status)) {
    throw new ApiError({
      status,
      message: "The answer has a status this operation does not declare.",
      requestId: headers.get(REQUEST_ID_HEADER),
      headers,
      body: decoder.decode(body),
    });
  }
  if (status === 204 || body.length === 0) return undefined as T;
  if (operation.binary) {
    const type = headers.get("content-type") ?? "application/octet-stream";
    return new Blob([body as Uint8Array<ArrayBuffer>], { type }) as T;
  }
  try {
    return JSON.parse(decoder.decode(body)) as T;
  } catch {
    throw new ApiError({
      status,
      message: "The answer is not the JSON this operation declares.",
      requestId: headers.get(REQUEST_ID_HEADER),
      headers,
      body: decoder.decode(body),
    });
  }
}
