# Changelog

This package follows [semantic versioning](https://semver.org). The API
version each release targets by default is `API_VERSION`.

## Unreleased

## 0.1.0-beta.1

First release, for API version `2026-10-01`.

- `Talki`: one property per tag and one method per `/v1` operation
  (`talki.calls.list()`, `talki.appointments.create({ body })`), generated
  from the OpenAPI document's tags and operation IDs, with the request and
  response types generated from its schemas.
- An API key, an access token or a self-renewing OAuth pair; `TALKI_API_KEY`
  read when none is passed; `Talki-Version` pinned on the client.
- An automatic `Idempotency-Key` on writes; retries that honour `Retry-After`
  and never repeat a write that may have been saved.
- One error class per error `type`, and `ConnectionError` /
  `RequestTimeoutError` for requests that got no answer.
- `withRawResponse` for the status and headers; `withOptions` for another
  timeout or retry count; a `signal` on every method.
- Lists that page: awaited for the first page, `for await` for every row,
  `iterPages()` and `position()` for change feeds.
- `@hubtec/talki/webhooks`: signature checks on WebCrypto, for webhook and app
  events.
- `@hubtec/talki/oauth`: consent URL with PKCE, callback, code exchange,
  refresh and revocation.
- Logging through a logger of your choice, silent by default, never a query
  string, header, body or token.
- No runtime dependencies; ES modules and CommonJS; Node 20 or later, Bun,
  Deno and Cloudflare Workers.
