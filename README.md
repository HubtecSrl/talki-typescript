# @hubtec/talki

The TypeScript client for the [Talki API](https://developers.talki.it) (`/v1`):
typed, generated from the published OpenAPI document, with a hand-written
layer for errors, retries, paging, webhooks and OAuth.

```sh
npm install @hubtec/talki@beta
```

No runtime dependencies: it is built on the global `fetch` and WebCrypto. It
runs on Node 20 or later, Bun, Deno and Cloudflare Workers, and ships ES
modules and CommonJS with their types.

> **Beta.** The API contract is versioned by date (`Talki-Version`) and does
> not break within a version; this package's own interface may still change
> before 1.0. See the [changelog](https://github.com/HubtecSrl/talki-typescript/blob/main/CHANGELOG.md).

## Call the API

```ts
import { Talki } from "@hubtec/talki";

const talki = new Talki({ apiKey: "talki_test_…" }); // or accessToken: "talki_at_…"; or set TALKI_API_KEY

const account = await talki.account.get();
console.log(account.business_name);

const appointment = await talki.appointments.create({
  body: { client_name: "Ada", client_surname: "Lovelace", start_at: "2026-11-02T09:30:00+01:00" },
});
await talki.appointments.cancel(appointment.id);

for await (const call of talki.calls.list({ limit: 100 })) {
  // every call, page after page
  console.log(call.id);
}
```

- `Talki` has one property per tag of the API reference (`talki.account`,
  `talki.appointments`, `talki.calls`, `talki.workingHours`, …), and each has
  one method per operation, named after it without the tag's noun:
  `listCalls` is `talki.calls.list`, `getCallTranscript` is
  `talki.calls.getTranscript`.
- A method resolves to the operation's value, or `undefined` for
  `204 No Content`, and rejects for an error (below). A file (a PDF or
  spreadsheet export, a voice sample) is a `Blob`.
- Path parameters are positional. Everything else goes in one object: the
  query parameters under the API's own names (`location_id`, `created_after`),
  `body`, and the options `idempotencyKey`, `ifMatch`, `talkiVersion` and
  `signal`.
- `body` is a plain object with the API's keys, typed from the spec, so the
  compiler catches a wrong key or value. Dates and datetimes are ISO strings;
  a `Date` in a body is sent as its ISO string too. The API checks the body,
  and refuses a wrong one with `400`.
- Every request and model type is exported: `Call`, `AppointmentCreate`, …,
  and per method `ListCallsParams`, `GetCallResponse`, `ListCallsRow`. The
  raw `paths`, `operations` and `components` types are there too.
- With no credential passed, `new Talki()` reads the API key from the
  `TALKI_API_KEY` environment variable, where `process.env` exists.
- A `Talki` holds no connection of its own and needs no closing: keep one for
  the life of the process.

### The whole response

When you need the status or the headers (`ETag`, `Idempotency-Replayed`, the
rate-limit headers, `X-Request-Id`), call the same method on
`withRawResponse`. It resolves to a `RawResponse`: `status`, `headers` (a
`Headers`), `requestId`, and `data`, the value the method returns. An error
rejects as it does from the method.

```ts
const raw = await talki.account.withRawResponse.get();
const account = raw.data;

// Refused with `412` if the account changed since that read.
await talki.account.update({ body: { greeting: "Buongiorno" }, ifMatch: raw.headers.get("ETag") ?? undefined });
```

### Other settings for some calls

`withOptions` returns the same client with another `timeout` (milliseconds) or
`maxRetries`, for the calls made on it. It shares the client's token renewal,
so it is cheap to make for one call:

```ts
await talki.withOptions({ timeout: 5000, maxRetries: 0 }).calls.get(callId);
```

Pass `signal` to any method to abort it, its retries and the waits between
them: `talki.calls.get(callId, { signal: AbortSignal.timeout(10_000) })`.

## Errors

A method rejects with a subclass of `ApiError` (itself a `TalkiError`) chosen
by the envelope's `type`: `InvalidRequestError`, `AuthenticationError`,
`PermissionDeniedError`, `ConflictError`, `RateLimitError` (with
`retryAfter`, in seconds), `ServerError`. An error with no envelope, such as a
proxy's answer, is classed by its HTTP status with `code` null (a maintenance
page is a 503), and a `type` this client does not know throws `ApiError`
itself. Each carries `status`, `type`, `code`, `apiMessage` (the API's own
text; `message` adds the status and code), `requestId`, `headers` and `body`.
Branch on `code`; quote `requestId` to Talki.

```ts
import { ConflictError } from "@hubtec/talki";

try {
  await talki.appointments.create({ body: booking });
} catch (error) {
  if (error instanceof ConflictError && error.code === "slot_unavailable") {
    // …
  } else {
    throw error;
  }
}
```

A request that got no answer rejects with `ConnectionError`, or
`RequestTimeoutError` (a subclass) after `timeout`. `sent` is false only when
the request certainly never left; `idempotencyKey` is the key it carried. An
abort through your own `signal` rejects with the signal's reason, as `fetch`
does.

## Retries

`Talki` retries, `maxRetries` times (default 2):

- any request that never left (the connection was refused, or its address
  never resolved);
- any request answered 429 or `409 request_in_progress`, which the API turns
  away before running it;
- a read answered 500, 502, 503 or 504, or whose connection broke or timed out
  after sending;
- a write with an `Idempotency-Key` answered 502, 503 or 504 by a gateway (not
  the API's error envelope).

Never retried: a write the API itself answered with a 5xx, or whose connection
broke or timed out after sending, since either may come after the write was
saved. Its key keeps a repeat from applying it twice: the API answers the key
of a write that saved and then failed with that same 500 for 24 hours, and
releases a key only when nothing was saved. Read the resource to learn which
happened before writing again.

It waits as `Retry-After` asks, up to 60 seconds; an answer asking for longer
is not retried but returned, as `RateLimitError` (with `retryAfter`) for a
429. Without `Retry-After` it backs off exponentially with jitter. `timeout`
applies to each attempt, the answer's body included. `maxRetries: 0` turns
retries off. A redirect is never followed.

## Logging

The client is silent until you give it a level:

```ts
const talki = new Talki({ apiKey, logLevel: "debug" }); // logs to console; or logger: yourLogger
```

- `debug`: every answer, as `POST /v1/appointments: 201, request req_… in 182 ms`
  (the time until its body arrived).
- `info`: every retry, with why and when; and every automatic token renewal.
- `warn`: an automatic renewal whose outcome is unknown. `error`: one refused
  with `invalid_grant` or `invalid_client`, after which the client stops
  asking.

`logger` takes any object with `debug`, `info`, `warn` and `error` methods
(`console`, pino, winston). A request is written by method and path only: its
query (a `phone=` or `q=` filter), headers and body never appear, nor does any
key or token. Quote the request ID to Talki when asking about a request.

Every request also carries `User-Agent: talki-typescript/<version>
<runtime>/<version>` (`node/22.11.0`, `bun/1.3.1`, `deno/2.5.0`); `VERSION` is
this package's. An integration can add its own name and version after it,
which helps Talki tell its requests apart:
`new Talki({ …, userAgent: "acme-crm/2.1" })`. Where the runtime refuses to
set `User-Agent` (a browser), the header is left as the runtime sends it.

## Enums

A set of values the API may extend (described as "New values may be added")
is typed as its known values or any other string: `Call["outcome"]` is
`"booked" | "rescheduled" | … | (string & {}) | null`. Your editor suggests the
listed ones, and a value added later still type-checks: handle one you do not
know.

Every other set is a union of its values, and gains a value only with a new
dated version. Answers are never checked against these types: a value a
union does not list reaches your code as the string it is, never an error.
Values in requests are not checked here either: an unlisted one is sent, and
the API answers `400 invalid_parameter`.

## Version and idempotency

- `Talki` sends `Talki-Version: API_VERSION`, the contract this package was
  generated from. `new Talki({ version: "…" })` pins another, and
  `version: null` sends none, so the version pinned on the key or app
  applies. Each method also takes `talkiVersion` for one request.
- `Talki` gives every write without an `Idempotency-Key` a new one, so its own
  retries are never applied twice. To retry a write yourself with the same
  key, pass your own as `idempotencyKey` (`newIdempotencyKey()` makes one), as
  in `talki.appointments.create({ body, idempotencyKey: key })`; after a
  `ConnectionError` the key sent is also in `error.idempotencyKey`.
  `409 request_in_progress` means the first request with that key is still
  running and its outcome is unknown: retry later with the same key.
  `autoIdempotency: false` sends none unless given; a blank key counts as
  none. Operations that require a key take it as optional here: without
  `Talki`'s, omitting it is refused with `400 idempotency_key_required`.
- `fetch` takes your own `fetch`: a proxy (undici's `ProxyAgent` as its
  dispatcher), instrumentation, or a test double.

## Paging and feeds

A method whose operation takes `cursor` returns a `PagePromise`. Await it for
the first `Page`: `data`, `hasMore` and `nextCursor`. `for await` it, or the
page, for every row of it and of the pages after it, fetched as the loop
reaches them; `iterPages()` yields the pages.

```ts
import { position } from "@hubtec/talki";

const page = await talki.calls.list({ limit: 50 });
console.log(page.data.length, page.hasMore);

for await (const call of talki.calls.list({ limit: 100 })) {
  // …
}

for await (const page of talki.appointments.list({ cursor: stored }).iterPages()) {
  await save(page.data);
  stored = position(page, stored); // store it with the rows
}
```

Nothing is sent until the list is awaited or iterated, and the first page is
fetched once however often it is awaited; a refused cursor rejects there. A
walk stops when `hasMore` is false and rejects with the `ApiError` of a page
that fails, after yielding those before it. A page that says `hasMore` but
gives no new cursor rejects with `PaginationError`. Walking a page again
starts from it again. `position` is for change feeds: a plain list's last page
has no cursor though it holds rows.

The change feeds (appointments, contacts, services, resources, unresolved
requests, and calls with `sync: true`) return `next_cursor` on every non-empty
page, the last included: store every non-null one and resume from it. Keep the
filters the same for a whole walk. A cursor used with another `location_id` is
refused; any other changed filter is accepted and skips the rows the first
walk filtered out.

## Webhooks

A webhook endpoint and an app's `events_url` receive events signed in
`X-Talki-Signature`. Check it on the raw body, before parsing:

```ts
import { constructEvent, signatureOf, SignatureVerificationError } from "@hubtec/talki/webhooks";

const body = new Uint8Array(await request.arrayBuffer()); // or await request.text()
try {
  const event = await constructEvent(body, signatureOf(request.headers), secret);
  // event.id, event.type, event.data
} catch (error) {
  if (error instanceof SignatureVerificationError) return new Response(null, { status: 400 });
  throw error;
}
```

- `constructEvent` resolves to the envelope as an object; `verifySignature`
  only checks. Both take the body as received: its bytes, or its text decoded
  unchanged. A body parsed and serialised again has other bytes and fails.
  Both refuse a signature more than 300 seconds from now (`tolerance` to
  change it).
- `signatureOf(headers)` finds the header in a `Headers` or a plain object,
  whatever its case.
- While a secret is rotated with an overlap, either secret verifies; pass an
  array when you hold more than one.
- They use WebCrypto only, so they run on edge runtimes; import them from
  `@hubtec/talki/webhooks` to load nothing else.
- Deliveries are not ordered and may repeat: deduplicate on the event's `id`,
  and order changes to one object by its `updated_at`. An account that also
  has its own webhook endpoint at the same URL sends the same change twice,
  with different `id`s.

## OAuth apps

`@hubtec/talki/oauth` covers an app installed on Talki accounts: the consent
URL with PKCE, the callback, the code exchange, refresh and revocation, and a
pair that renews itself.

```ts
import { Talki } from "@hubtec/talki";
import { OAuthApp, authorizationUrl, createPkce, readCallback } from "@hubtec/talki/oauth";

const app = new OAuthApp(clientId, clientSecret); // { baseUrl } for another deployment
const pkce = await createPkce();
const state = crypto.randomUUID();
const url = authorizationUrl(clientId, redirectUri, ["calls:read"], { state, pkce });
// … send the customer's browser to url; then, on the callback:
const code = readCallback(callbackUrl, { state });
const tokens = await app.exchangeCode(code, { redirectUri, codeVerifier: pkce.verifier });
await save(tokens);

const talki = new Talki({ tokens, oauthApp: app, onTokenRefresh: save });
```

- A `TokenSet` is a plain object (`accessToken`, `refreshToken`, `expiresAt`
  in milliseconds since the epoch, `scopes`, `accountId`, `installationId`,
  `livemode`): store it as JSON and pass it back as `tokens`. It holds
  secrets: never log it.
- With `oauthApp`, `Talki` renews the pair a minute before it expires, and
  when the API answers `401` with `error="invalid_token"`, then sends the
  request again. `talki.tokens` is the pair in use (a new one waiting to be
  stored is not in use yet). `oauthApp` must talk to the same `baseUrl` as
  `Talki`.
- **The refresh token rotates on every renewal, and presenting a rotated one
  again revokes the installation.** One `Talki` and its `withOptions` copies
  serialise their renewals. Keep one `Talki` per installation per process,
  and never renew one pair from two of them.
- A renewal whose outcome is unknown (its connection broke or timed out, or a
  gateway's 502, 503 or 504) may have rotated the pair. The server takes the
  same refresh token once more within 60 seconds of that rotation, so `Talki`
  presents it again in the same request, 10 seconds after the outcome was
  lost (so as not to overlap the first), while that is still inside the 60
  seconds. When it is not (a `timeout` above 45 seconds), the request rejects
  and the next one presents it again, which works only if the first never
  reached the server: otherwise the customer has to reconnect. A caller's
  `signal` never abandons a renewal half way: the request waits for it, then
  rejects.
- `onTokenRefresh` is called with the new pair before it is used, and awaited:
  store it there. If it throws, the pair stays pending in memory and every
  request rejects until a later call stores it; the replaced refresh token is
  never presented again. A process that ends with a pair unstored can renew
  once more with the old refresh token within 60 seconds; after that the
  customer has to reconnect.
- Never await a request on the same `Talki` inside `onTokenRefresh`: it waits
  for the renewal, which waits for your callback, and neither ever ends.
- Once the API refuses the refresh token (`invalid_grant`: the customer
  disconnected, the pair was revoked, or Talki disabled the app) or the app's
  credentials (`invalid_client`), every request rejects with that
  `OAuthError` without asking again. Build a new `Talki` once fixed.
- A code works once: never retry `exchangeCode` with the same code.
- The token endpoints answer in RFC 6749's shape, thrown as `OAuthError`
  (`error`, `description`, `status`).
- Against another deployment, pass its addresses: `new OAuthApp(…, { baseUrl })`,
  `new Talki({ baseUrl })`, `authorizationUrl(…, { authorizeUrl })` and
  `readCallback(…, { issuer })`.

## Not covered yet

The partner routes (`/oauth/app/*`, `/oauth/managed-accounts`,
`/oauth/enrollments`) and typed webhook event payloads are not in the OpenAPI
document yet, so not in this package. See the
[API reference](https://developers.talki.it) for them.

## Versions

This package follows semantic versioning of its own. `API_VERSION` is the
dated API version it was generated from and sends by default; a release that
moves to a newer API version says so in the changelog.

## Development

`src/generated/` is generated, never edited by hand: `scripts/generate.mjs`
runs openapi-typescript (pinned in `package.json`) over
`openapi/talki-v1.yaml` for the types, and writes the resource classes
(`talki.calls`, …) itself from the spec's tags and operation IDs. Everything
else in `src/` is hand-written.

```sh
npm ci
node scripts/pull-spec.mjs <path or URL>  # refresh the OpenAPI document
npm run generate                          # regenerate src/generated from it
npm run generate:check                    # CI: fail if src/generated is stale
npm test
npm run typecheck
npm run lint
npm run build && npm run smoke
```

To change generated code, change the generator; a change to the API itself
belongs in the API.

## License

[MIT](https://github.com/HubtecSrl/talki-typescript/blob/main/LICENSE)
