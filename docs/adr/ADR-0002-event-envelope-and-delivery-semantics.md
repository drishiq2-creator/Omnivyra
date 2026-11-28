# ADR-0002 — Versioned event envelope and at-least-once semantics

**Status:** Proposed (2026-11-28) · **Scope:** contract now; transport is future work

## Context

What exists today (read from code, 2026-11-28, origin/main d9d047ae8):

- `domain_events` (`backend/services/domainEventLogger.ts`) is an **observational,
  fire-and-forget log** of domain-verification outcomes. `logDomainEvent` never
  throws and returns `false` on failure; nothing consumes it as a queue.
- `orchestrationEventBus` (`backend/services/orchestration/events/orchestrationEventBus.ts`)
  is an **in-process** EventEmitter by default. When `REDIS_URL` is a remote Redis,
  `ensureDistributedOrchestrationTransport()` registers a Redis pub/sub transport, and
  `durableOrchestrationEventStream.ts` appends to a Redis Stream per campaign
  (`MAXLEN ~500`, 24 h TTL). All of it is **fail-soft** and documented as
  "event = hint, feed = truth": UI hydration hints for campaign asset cards, not
  a delivery guarantee.
- `plannerEventBus` is in-process with optional BullMQ publishing for planner phases.
- Listening events (`backend/events/listeningEventsBus.ts`) are in-process; with no
  subscriber they are dropped.

**No durable outbox exists today.** No event above is written in the same
transaction as the state change it describes, so a crash between "state changed"
and "event published" loses the event, and nothing replays it.

## Decision

1. Every controller event is an **envelope** (`backend/contracts/controllers/eventEnvelope.ts`):
   `event_id` (uuid), `event_type`, `event_version` (int ≥ 1), `tenant_id`, `company_id`
   (both required), `source_controller`, optional `target_controller`,
   `correlation_id`, `causation_id` (null only for a flow's root), `entity_type`,
   `entity_id`, `occurred_at` (ISO-8601 with offset), `payload`.
2. The envelope is strict (unknown and symbol top-level keys rejected). The payload is
   validated per event by a strict schema in the catalogue, and is walked at every
   depth (string and symbol keys, enumerable or not, named properties on arrays; getters
   are never invoked). A hit **rejects** the event; it is never silently redacted.
   Exactly what is enforced (`backend/contracts/controllers/eventEnvelope.ts`):
   - **Keys**, after NFKC normalisation and case folding: any key containing
     token, jwt, bearer, password/passwd/passphrase, secret, api key, authorization,
     auth header, cookie, private key, signing key, session key or one-time password;
     the whole words otp/totp/hotp/pwd/auth/sid; the exact unqualified `session` /
     `session_id`; and anything the central `isSecretKeyName` rule
     (`backend/security/logRedaction.ts`) flags. No descriptive-suffix carve-out
     applies (`token_source`, `secret_name` are rejected). The only exemption is an
     exact list of LLM usage counters (`prompt_tokens`, `completion_tokens`,
     `total_tokens`, `input_tokens`, `output_tokens`, `max_tokens`,
     `cached_tokens`, `reasoning_tokens`). An entity-qualified session id such as
     `voice_session_id` is a domain id and allowed. A key that is still non-ASCII after
     NFKC is rejected (homoglyphs).
     This is **intentionally stricter than log redaction** (coordinator decision
     2026-11-28): `isSecretKeyName` keeps `token_count`, `tokens`, `*_name`,
     `*_source` etc. because redacting a log line has a cosmetic cost, whereas an
     event payload has no reason to carry them at all, so they are rejected here.
     Pinned examples (rejected by design, asserted by the contract test):
     `token_count`, `auth_status`, `cookie_consent`, `signature`.
   - **Values** (conservative): `Bearer <x>` / `Basic <x>`, three-part `eyJ…` JWTs,
     PEM private-key headers, and a fixed list of provider prefixes (Anthropic, OpenAI,
     Stripe, Stripe webhook, Supabase, AWS access key, GitHub, Slack, Google API key,
     Google OAuth secret, Google OAuth access token `ya29.`). An arbitrary random secret without such a shape is **not**
     detected; the key rules and strict payload schemas (ids and codes only) are the
     main defence.
   - **One snapshot**: the input is copied once into plain data (no getter or Proxy
     trap runs; a Proxy anywhere is rejected; properties are copied with
     `Object.defineProperty`, never assignment, into ordinary objects whose prototype
     is `Object.prototype`), and the scan, the schema parse and the
     returned envelope all use that copy — what is scanned is exactly what is returned.
   - **Reserved own keys** `__proto__`, `constructor`, `prototype` are rejected at
     any level (a JSON-parsed `"__proto__"` is an own key that a naive copy would turn
     into a prototype; the other two are rejected for consistency — never a legitimate
     event field).
   - **Fail closed**: true cycles (a shared non-cyclic reference is allowed), payloads deeper than 12 or larger than 5000 nodes,
     strings over 64 KiB, non-plain objects, functions/symbols/bigints, and any
     internal validator error are rejections. The validator never throws.
3. Versioning: a breaking payload change is a new `event_version` row in the
   catalogue; the old version stays until no producer emits it. A consumer must
   reject a version it does not know.
4. Delivery is **at-least-once**. Consumers dedupe on `event_id` and must be
   idempotent; ordering is per `entity_id` at best and must not be assumed globally.
5. Reuse, don't duplicate: an existing event with the same meaning keeps its wire
   name (`ProspectSignalDetected` is carried as `lead_signal.created`).

## Proposed next step (not done here)

A **durable outbox on the existing BullMQ/Redis** (no new runtime service, no second
bus): the producer writes the outbox row in the same transaction as its state change,
and a relay enqueues it on BullMQ with `jobId = event_id` (natural dedupe). The outbox
table needs a migration, so its **migration version id must be reserved via the
coordinator** (migration coordination: control-tower (interim)) before anyone writes it.

## Consequences

- Until the outbox exists, no catalogue event may be treated as guaranteed;
  "at-least-once" is the contract the transport must meet, not a property today.
- Each execution outcome travels in exactly one event: `ExecutionCompleted`
  (attempted | accepted | delivered), `ExecutionFailed` (not_attempted | failed),
  `ExecutionOutcomeUnknown` (unknown — the only event that may carry it). A lost
  provider response is an `ExecutionOutcomeUnknown`: never retried as if it had not
  happened, never counted delivered, never counted failed. The catalogue integrity
  check refuses any other outcome-bearing row whose outcome enum admits `unknown`.
  Voice SDR mirrors this on `call_outcome`: `VoiceSessionCompleted`,
  `VoiceSessionFailed`, and `VoiceSessionOutcomeUnknown` (the only voice event that
  may carry `unknown`); the same integrity rule applies to voice rows.

## Alternatives considered

- **Reuse `domain_events` as the outbox.** Rejected — wrong schema, fire-and-forget
  by design, and owned by domain verification.
- **Promote the orchestration Redis Stream.** Rejected — capped at ~500 entries with
  a TTL and fail-soft by design; it is a UI hint channel.
- **Exactly-once.** Rejected — not achievable across Supabase + Redis without a
  distributed transaction; idempotent consumers are cheaper and honest.
