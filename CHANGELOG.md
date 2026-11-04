# Changelog

This package follows [semantic versioning](https://semver.org). The API
version each release targets by default is `API_VERSION`.

## Unreleased

## 0.3.0-beta.1

Still API version `2026-10-01`. No method was added, renamed or removed, but
this release is not purely additive: some field types changed, and so did what
the API answers in a few cases, so code written for 0.2 may need a small change.

New:

- `talki.contacts.list({ phone })` and `talki.contacts.list({ tag_id })` find
  contacts. `phone` is E.164, or a national number read as Italian. Either one
  makes the list a search, not the change feed: newest contact first, no cursor
  on the last page, and a cursor works only in the mode that issued it. Pass
  neither to resume a sync, and don't use `position()` on a search. A `null` is
  dropped like any null query value, which lists the feed instead of finding
  nothing, so check for one first.
- A new webhook event, `call.ringing`, sent while an inbound call rings:
  `data.call_id`, `data.location_id`, `data.caller` (`contact_id`,
  `phone_number`, `display_name`, `vip`) and `data.started_at`. `data.call_id`
  is the id the Call will have, but not every ring is followed by one, and
  `talki.calls.get()` answers 404 until the call has ended. An endpoint
  subscribed to every event starts receiving it, and sandbox calls send it too;
  an OAuth app gets it by subscribing to it, with `calls:read`. `constructEvent`
  returns it like any other event: the package has no types for event payloads.
- `Appointment.notes`: what `talki.appointments.create()` sent, or the note the
  assistant wrote on a voice booking. Always present, null when there is none,
  and on the `appointment.*` events too. It is a required key in the type, so a
  hand-built `Appointment` needs it.
- `usage.threshold_reached` and `usage.extra_credits_low` carry the names
  `GET /v1/usage` uses (`used_seconds`, `extra_seconds`, …). The older names
  still arrive with the same values and are deprecated.
- A token request refused by the per-address limit is an `OAuthError` with
  `error` `ip_rate_limited`, no longer `unexpected_response`.

What changes for your code:

- A withheld caller is `null`, not `+` or `+nonymous`. `PendingContact.phone_number`
  and `CallStatsCaller.phone_number` are now `string | null`, so reading them as
  `string` no longer compiles. In the call stats, every call with no number is
  one row, which now includes calls with no caller ID at all; a pending contact
  with no number cannot be approved, only discarded.
  `Call.caller.phone_number`, `RefusedCall.caller.phone_number`,
  `AppointmentClient.phone_number` and `UnresolvedRequest.caller_phone` were
  already nullable and now hold `null` too, and the call exports print no number.
  Replace any check for `+` with one for `null`.
- Request fields the API has always refused as `null` no longer accept it in
  their types, so that mistake fails at compile time instead of with a `400`:
  in `AccountUpdate`, `voice`, `answers_as`, `multilingual_enabled`,
  `transfer_numbers`, `bookings_enabled`, `unresolved_requests_enabled`,
  `remember_callers`, `notify_on_every_call`, `notify_on_incoming_call` and
  `store_transcripts`; `CallUpdate.read` and `.archived`; `CallerRuleUpdate.kind`;
  `ClosureUpdate.kind` and `.all_day`; `DocumentUpdate.title` and `.enabled`;
  `ServiceUpdate.name`, `.duration_minutes` and `.is_active`; and
  `UnresolvedRequestUpdate.status`. Omit a field to leave it unchanged.
- `talki.appointments.reschedule()` on a booking of one timed service with a
  `duration_minutes` must keep that length, or the length the booking has now.
  A move that changes it is refused with `400 invalid_parameter`, which is what
  moving only `start_at` or only `end_at` usually does: send both.
- `CallTransfer.at` and the `transferred_at` of `call.transferred` are in UTC,
  ending in `Z`. The instant is the same; only the spelling changed, so parse
  them instead of comparing the text or reading a local time from the offset.
- `CallTransfer.target_label` is the label as the owner wrote it. Calls stored
  earlier keep the casing they had, so compare it ignoring case.
- A refusal a retry can change no longer holds the `idempotencyKey`. When the
  request saved nothing, the same key runs it again after a `400` asking for a
  different request (such as `invalid_parameter`), a `415`, or a `409`
  `request_conflict`, `document_not_ready` or `check_in_progress`. Any other
  refusal is replayed for 24 hours, including a `400` that depends on the
  business's state (such as `party_too_large`) and a time already taken: once
  the cause is gone, or to send a different body, use a new key.
- A change-feed cursor now names its feed, and one from another feed is refused
  with `400 invalid_cursor`. A cursor stored earlier names none: any feed takes
  it until 2027-02-01, after which it is refused and the walk has to start again.
  The first page read with it returns a new one to store, an empty page included.
- Sandbox scenarios list `call.ringing` in their `events` and send it, so a test
  asserting the exact list needs updating, and other events can come too, such as
  `pending_contact.created`. `talki.sandbox.createCall()` returns `caller_phone`
  in E.164.
- A redelivery of an event stored before this change resends the payload as it
  was stored: it can still hold `+`, lack `notes` or the new usage names, and
  carry the old transfer time.

Corrected descriptions, with no change in what the API does:

- The switches on `Account` and `AccountUpdate` belong to one location, not the
  whole account: `location.settings_updated` reports a change at any location but
  the main one, and `call_auto_archive_days` is refused with another location's
  `location_id`.
- `talki.sandbox.reset()` deletes the account's webhook endpoints: register them
  again after a reset.
- `talki.appointments.create()`, `reschedule()` and `cancel()` list the codes
  they refuse with.

## 0.2.0-beta.1

Still API version `2026-10-01`; the additions below are additive.

- `talki.documents`: the knowledge base the assistant answers from. List,
  read (`get`, `getText`, `getFile` for the original, `listPages` for a
  website), write text notes, files and websites (`create`, `replace`,
  `update`, `delete`, `deletePage`), and `discoverPages` to find a website's
  pages before adding it. Reading needs `knowledge:read`; writing needs
  `knowledge:write`, an opt-in scope.
- File uploads: an operation that takes a file accepts `form` instead of
  `body`, sent as `multipart/form-data`. `toFile(source, name)` makes the
  `File` from bytes, text, a `Blob` or a stream.
- A download that names its file in `Content-Disposition` resolves to a
  `File` of that name (less any directory) instead of a plain `Blob`.
- `Account` and `AccountUpdate`: `call_auto_archive_days`.
- `ErrorDetail.code` lists two new codes, `document_not_ready` and
  `unsupported_file_type`.

## 0.1.0-beta.2

No changes to the package. The first release published from CI by npm trusted
publishing, with a provenance attestation.

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
