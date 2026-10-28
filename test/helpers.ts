import { HOOKS, Talki, type TalkiOptions } from "../src/client.js";
import type { Hooks } from "../src/transport.js";

/** A request as the mocked `fetch` saw it. */
export interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export type Answer = Response | Error | ((request: Seen, init: RequestInit) => Response | Promise<Response>);

/** Answers in order (the last one repeated), and every request seen. */
export class Recorder {
  readonly answers: Answer[];
  readonly requests: Seen[] = [];

  constructor(...answers: Answer[]) {
    this.answers = answers;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const seen: Seen = {
      method: init.method ?? "GET",
      url: new URL(input),
      // A copy: the client may change its headers for the next attempt.
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : "",
    };
    this.requests.push(seen);
    const answer = this.answers.length > 1 ? (this.answers.shift() as Answer) : (this.answers[0] as Answer);
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(seen, init);
    return answer.clone();
  };

  get paths(): string[] {
    return this.requests.map((request) => request.url.pathname);
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function envelope(status: number, type: string, code: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { type, code, message: "m", request_id: "req_1" } }, headers);
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

export function html(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/html" } });
}

/** A failed connection that never reached the server. */
export function refused(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
}

/** A connection that broke after the request may have arrived. */
export function dropped(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

/** A client on ``recorder`` whose waits are recorded, not waited. */
export function make(recorder: Recorder, options: TalkiOptions & { sleeps?: number[]; hooks?: Hooks } = {}): Talki {
  const { sleeps = [], hooks = {}, ...rest } = options;
  return new Talki({
    apiKey: "talki_test_x",
    fetch: recorder.fetch,
    ...rest,
    [HOOKS]: {
      sleep: async (seconds: number) => {
        sleeps.push(seconds);
      },
      ...hooks,
    },
  } as TalkiOptions);
}

/** An answer that never comes: the request waits until its signal aborts it, as `fetch` does. */
export function hang(_seen: Seen, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

export const APPOINTMENT = { client_name: "Ada", client_surname: "Rossi", start_at: "2026-11-03T10:00:00+01:00" };
