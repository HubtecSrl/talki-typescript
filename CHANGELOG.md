# Changelog

This package follows [semantic versioning](https://semver.org). The API
version each release targets by default is `API_VERSION`.

## Unreleased

## 0.5.0-beta.1

Still API version `2026-10-01`. No method was renamed or removed. One type
gained two required fields, which a hand-built object of it needs.

New:

- `talki.whatsapp`: how Talki answers the business's WhatsApp chats, and the
  chats themselves. Talki answers customers as on the phone, with the same
  knowledge, services, hours and calendar, and steps back as soon as the owner
  writes in a chat. The owner connects the WhatsApp Business number in the
  Talki app; the API cannot.
  - `talki.whatsapp.get()` returns a `WhatsApp`: the number (`connection`),
    the `mode` (`off`, `always` or `scheduled`), the `schedule`,
    `after_hours_schedule` (every time the main location is closed, ready to
    send as `schedule`), whether Talki can answer (`available`, and
    `blocked_reason` when not), this period's `usage`, `pending_questions` and
    `stored_conversations`. Needs `whatsapp:read`.
  - `talki.whatsapp.update({ body: { mode, schedule } })` changes the mode,
    the schedule or both. Turning the answers on from `off` is refused without
    a plan that includes WhatsApp chats (`PermissionDeniedError`,
    `plan_feature_unavailable`), without a connected number (`ConflictError`,
    `whatsapp_not_connected`), or while Talki does not answer WhatsApp chats
    yet (`ConflictError`, `whatsapp_chats_unavailable`). Set the contact rules
    first: from then on Talki answers whoever writes, apart from the contacts
    it judges personal. Needs `whatsapp:write`.
  - `talki.whatsapp.listConversations()` pages through the conversations
    Talki took part in or kept out of, newest first; `needs_answer: true`
    lists those waiting for the owner's «è un cliente?».
    `talki.whatsapp.getConversation(id)` returns one `WhatsAppConversation`:
    who wrote, its summary and `outcome`, and the owner's `question`. Both
    need `whatsapp:read`.
  - `talki.whatsapp.getConversationMessages(id)` returns its messages, oldest
    first. It needs `transcripts:read`, which `whatsapp:read` does not grant.
    Messages are kept 30 days; after that `messages_expired` is true and the
    conversation's record stays.
  - `talki.whatsapp.answerConversation(id, { body: { answer } })` answers
    «è un cliente?» for the owner, on any conversation, asked or not:
    `customer` (Talki answers the contact, now if WhatsApp's 24-hour window is
    still open), `ignore` (never again) or `owner` (the owner replies; Talki
    leaves the chat until the next day). `customer` and `ignore` set a contact
    rule. Needs `whatsapp:write`, and a plan that includes WhatsApp chats
    (`PermissionDeniedError`, `plan_feature_unavailable`), as do
    `createContactRule()` and `updateContactRule()`.
  - `talki.whatsapp.listContactRules()`, `createContactRule()`,
    `updateContactRule()` and `deleteContactRule()` manage the contacts Talki
    never answers (`ignore`) or answers as customers without judging first
    (`customer`): one rule per number, at most 500 per account. Listing needs
    `whatsapp:read`, the rest `whatsapp:write`. A number that already has a
    rule is a `ConflictError` with code `whatsapp_contact_rule_exists` (change
    it with `updateContactRule()`); a rule past the 500th, also one set by
    `answerConversation()`, is `whatsapp_contact_rule_limit_reached`. A
    creation counts toward the 20 per minute shared with services, resources,
    tags and caller rules. Deleting a rule leaves the contact to Talki's own
    judgement.
  - `talki.whatsapp.deleteConversations()` deletes every stored conversation
    and its messages; the contact rules, the appointments booked in a chat and
    the requests it left stay. It needs the opt-in `whatsapp:delete` scope and
    a live-mode credential (`livemode_required`), and is refused while Talki
    answers the chats (`ConflictError`, `whatsapp_answers_on`): set `mode` to
    `off` first.
- Two webhook events with the `WhatsAppConversation` as `data.object`. An
  OAuth app gets them by subscribing to them, with `whatsapp:read`.
  - `whatsapp.conversation_ended`: a conversation closed, about 30 minutes
    after its last message, also one Talki kept out of; sent again if it
    reopens and closes once more. A conversation closed otherwise (the
    contact's two chats merged, or found still open when the contact wrote
    again much later) sends none: `listConversations()` lists it all the same.
  - `whatsapp.question_asked`: Talki kept silent with an unknown contact and
    asks the owner «è un cliente?»; answer with `answerConversation()`. Sent
    once per contact.
- A webhook event, `whatsapp.message_sent`: after a call, the assistant sent
  the caller a WhatsApp message from the business's own number, with the
  caller's consent, and WhatsApp accepted it. `data.object` is the `Call`, and
  `data.message` has the message's `id`, `type`, `language` and `sent_at`, not
  its text. Delivery is not reported. An OAuth app gets it by subscribing to
  it, with `calls:read`.
- `UnresolvedRequest.source`, `call` or `whatsapp`, and
  `UnresolvedRequest.whatsapp_conversation_id`, the conversation a request
  from WhatsApp was raised in: null for a request from a call, and once the
  conversation is deleted. A request from WhatsApp has `call_id` null and the
  main location as `location_id`. Both are on `unresolved_request.updated`
  too.
- `ErrorDetail.code` lists five new codes: `whatsapp_not_connected`,
  `whatsapp_chats_unavailable`, `whatsapp_answers_on`,
  `whatsapp_contact_rule_exists` and `whatsapp_contact_rule_limit_reached`.
- `call_auto_delete_days` on `Account` and `AccountUpdate`: how many days after
  it started a call is deleted for good, read or not (`30`, `60`, `90` or
  `180`), or `null` to keep calls until the 365-day retention limit. Deletion
  runs once a night, as `talki.calls.delete` would, and sends `call.deleted`
  for each call. Setting a number needs the `calls:delete` scope as well as
  `account:write`, and is refused in test mode (`livemode_required`). The
  account's own setting: the same at every location.
- New types: `WhatsApp`, `WhatsAppUpdate`, `WhatsAppConversation`,
  `WhatsAppChatMessage`, `WhatsAppContactRule` and the others named
  `WhatsApp…`, with the parameter and response types of the new methods.

What changes for your code:

- `source` and `whatsapp_conversation_id` are required keys of
  `UnresolvedRequest`, so a hand-built one, such as a test fixture, no longer
  compiles until it has them.
- Unresolved requests now come from WhatsApp chats as well as calls, with no
  `call_id`. Treat a `source` you do not know as a request to handle all the
  same.

## 0.4.0-beta.1

Still API version `2026-10-01`. No method was renamed or removed; one type
widened, which can break code that lists every value of it.

New:

- `talki.agentTest`: chat in text with the account's assistant, as the test in
  the Talki apps does, to check how it answers before a caller does.
  `talki.agentTest.send({ body: { message } })` returns an `AgentTestReply`:
  `reply`, the `session_id` to send with the next message, `turn` and
  `max_turns`, `expires_at`, `daily_remaining` and `tools_called`. Pass
  `location_id` to talk to another location's assistant; a session stays at
  the location it started at. `talki.agentTest.end(sessionId)` drops a session
  before it expires. Talki saves nothing from a test: no call, appointment or
  unresolved request is recorded, and a booking is not made. Your app's own
  partner tools do run, writes included, sent with `test_drive: true`: check
  that flag in your tool to keep a test from changing your records. No other
  app's tools run. Both methods need `account:write` and `knowledge:read`.
  Limits and refusals:
  - A session holds 20 turns and is kept for 30 minutes after its last one; a
    message past the last turn is a `ConflictError` with code
    `agent_test_session_full`. A session belongs to the credential that
    started it.
  - A second message sent while the session is still answering the first is a
    `ConflictError` with code `request_conflict`: wait for the reply, then send
    it again.
  - An account may send 25 test messages a day, shared with the Talki apps, and
    an OAuth app 300 a day across its installations. Past either, a
    `RateLimitError` whose `retryAfter` runs to midnight in the account's
    timezone. That is longer than the client waits on its own, so it is thrown
    at once, except in the last minute before midnight. Past 15 messages a
    minute, the client waits and retries as for any other `429`.
  - A `ConflictError` with code `account_suspended` while the managing partner
    has suspended the account, and a `ServerError` with code
    `agent_test_unavailable` while the feature is switched off (not retried:
    try again later).
- `talki.usage.getHistory({ location_id })` counts only that location's calls;
  the locations' months add up to the account's. An unknown `location_id` is a
  `404`. `talki.usage.get()` stays one meter for the whole account.
- `Account.call_auto_archive_days` and `AccountUpdate.call_auto_archive_days`
  take `180`.
- `RefusedCall.reason` and `RefusedCallSummary.by_reason` list `suspended`: the
  partner that manages the account has suspended the service. Its `action` is
  `reactivate_subscription`.
- `ErrorDetail.code` lists three new codes: `account_suspended`,
  `agent_test_session_full` and `agent_test_unavailable`.
- New types: `AgentTestMessage` and `AgentTestReply`, with the parameter and
  response types of the two new methods.

What changes for your code:

- `call_auto_archive_days` is now `7 | 30 | 90 | 180 | null`. A `switch` that
  checks it is exhaustive, or a `Record<7 | 30 | 90, …>` indexed by it, no longer
  compiles until it handles `180`.
- `Usage.included_seconds` is the plan's talk time, or the monthly minutes the
  managing partner set for the account when those are lower or the plan has no
  limit; `Usage.unlimited` is true only when neither limits it. The same goes
  for `included_seconds` of `usage.threshold_reached` and `minutes_included`
  of `usage.threshold_reached` and `usage.extra_credits_low`.
- `talki.account.update()` refuses a premium-rate or shared-cost number in
  `transfer_numbers`, unless the list being replaced already holds it.

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
