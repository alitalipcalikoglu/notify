# `notify` readiness contract

## Purpose
`notify` is the platform's queued delivery service: other services enqueue a notification
(templated email over SMTP, or a signed webhook) via `POST /v1/messages`; `notify` persists it in
SQLite, renders and delivers it from an in-process background worker with retries and backoff, and
exposes delivery status and lifecycle through `GET` endpoints. It lets the rest of the platform
fire-and-forget notifications without every caller embedding its own SMTP/webhook client, retry
logic and delivery-state bookkeeping.

## Dependencies
- **audit service** (`AUDIT_URL` + `AUDIT_API_KEY`): optional, but the two env vars must be set
  together — `Config.fromEnv` throws `ConfigError` at startup if only one is set, so there is no
  half-configured state. When unset, `AuditClient.target` is `null`, `enabled` is `false`, and
  `record()` is a no-op that returns `false` — every `notify` write proceeds normally with no audit
  trail. When set, forwarding is buffered and fire-and-forget: `record()` only pushes to an
  in-memory array on the request path; the actual HTTP call happens later on a timer. Audit being
  down never fails or slows a `notify` request (confirmed in `audit.test.js`'s "dead" case: a
  permanently-unreachable audit target leaves `stats.failed` incremented and the event kept in
  `buffer` for the next flush — nothing propagates back to the caller).
- **SMTP server** (`SMTP_URL`): required at startup — `Config.fromEnv` throws if missing, or if it
  doesn't start with `smtp://`/`smtps://` and isn't the literal `json:` dev value. Functionally,
  only email delivery depends on it directly: if SMTP is unreachable, `EmailChannel.deliver()`
  throws and the message retries per the backoff policy; the HTTP API and webhook delivery keep
  working. However, `GET /ready` calls `verify()` on every registered channel, and
  `EmailChannel.verify()` performs a real SMTP handshake (`transport.verify()`) — so an unreachable
  SMTP server makes the *whole service* report `503` from `/ready`, even though webhook delivery
  and the read/write API would still function. This coupling is real and un-mitigated in the code
  today.
- **Webhook receivers**: not a fixed dependency — each is an arbitrary caller-supplied URL, vetted
  by `NetGuard` before every delivery attempt. An unreachable or blocked receiver only fails that
  message's delivery (retryable or not depending on cause); it never affects `/ready`, the API, or
  email delivery.

## Persistence
Engine: SQLite via Node's built-in `node:sqlite` (`DatabaseSync`), no native module. File at
`DB_PATH` (default `./data/notify.db`; `:memory:` in tests). Pragmas set on open: `journal_mode =
WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON`.

Schema: one table, `messages` — `id` (PK), `api_key_id`, `idempotency_key`, `channel`
(`email`/`webhook`), `payload` (JSON text), `status` (`queued`/`processing`/`sent`/`failed`),
`attempts`, `max_attempts`, `next_attempt_at`, `locked_until`, `last_error`, `provider_id`,
`created_at`, `updated_at`, `sent_at`. Four indexes: a unique index on
`(api_key_id, idempotency_key)` where the key is not null (idempotency enforcement), `(status,
next_attempt_at)` for claiming due work, `(api_key_id, created_at DESC, id DESC)` for listing, and
`(status, updated_at)` for the retention purge scan.

Migration mechanism: `Database.MIGRATIONS` is an ordered, append-only array of SQL strings.
`PRAGMA user_version` tracks how many have been applied. On every open, `#migrate()` runs each
not-yet-applied migration inside `BEGIN`/`COMMIT` (with `ROLLBACK` on error) and advances
`user_version`. There is currently exactly one migration (the initial schema), so there is no
tested example yet of a schema change against an existing database.

Fresh install: the DB file doesn't exist, `mkdirSync` creates the parent directory, migration 0
creates the table and indexes, `user_version` becomes 1. Upgrade: the existing file opens with
whatever `user_version` it already has; only migrations at or after that index run. No data
backfill logic exists because there has only ever been one migration to test against.

## Health endpoint
`GET /health`, no auth, `logLevel: 'warn'` (kept out of normal access logs). Checks nothing —
the handler is a static `async () => ({ status: 'ok' })` with no dependency lookups at all. It
cannot fail or block on a dependency; the only way it is slow is if the event loop itself is
starved (e.g. by a long synchronous SQLite call elsewhere), which would also slow every other
endpoint equally.

## Readiness endpoint
`GET /ready`, no auth. Checks `queue.db.ping()` (`SELECT 1`) and, for every registered channel,
`channel.verify()` — `EmailChannel.verify()` does a real `transport.verify()` SMTP handshake (a
no-op against the `json:` dev transport); `WebhookChannel` does not override `verify()`, so it
inherits the base `Channel`'s no-op and is effectively never checked. The result is cached in
`this.readyCache` for `NotifyApi.READY_CACHE_MS` = `30_000` ms — a hardcoded constant, not
environment-configurable. A request inside that 30 s window reuses the cached outcome rather than
re-probing. Returns `200 {status:'ok'}` when the cached check passed, `503
{status:'unavailable', error}` when it last failed. Safe to poll: no state mutation, nothing
discarded — the only side effect is, at most once per 30 s, a DB read and an SMTP handshake
attempt, neither of which writes to the `messages` table or touches queued work.

## Graceful shutdown
Signals: `SIGTERM` and `SIGINT` both call `Application#shutdown(reason)`; `unhandledRejection`
logs fatal and also calls `shutdown()`; `uncaughtException` calls `process.exit(1)` directly with
no graceful path. `shutdown()` is guarded by a `shuttingDown` flag, so a second signal is a no-op.

Order, as written in `src/application.js` (verified against the file, not assumed):
1. `await this.app?.close()` — Fastify stops accepting new connections and runs its own close
   lifecycle.
2. `await this.audit.close()` — stops the flush timer and performs one final `flush()`, using the
   same retry/backoff as a normal flush.
3. `await this.worker?.stop()` — stops claiming new work, aborts the poll-sleep, and awaits the
   worker's in-flight loop promise, so any deliveries already claimed in the current batch finish.
4. `for (const ch of this.channels) ch.close()` — `EmailChannel` closes its pooled SMTP
   connections; `WebhookChannel` has no `close()` override, so it's a no-op.
5. `this.db.close()`.

On success: `process.exit(0)`. Force-exit timeout: a `setTimeout(...).unref()` set to
`this.config.lockTtlMs` — i.e. the **`LOCK_TTL_MS`** environment variable (default `120_000` ms =
120 s), read directly off `this.config.lockTtlMs` in the file. It is not a dedicated shutdown
timeout variable and not `WORKER_POLL_MS`.

Comparison with PM2: `ecosystem.config.cjs` sets `kill_timeout: 60000` (60 s), with a comment
assuming that's enough because "SMTP socket timeout is 30s". The app's own internal force-exit
only fires after 120 s by default — twice as long as PM2's `kill_timeout`. In practice this means
PM2's SIGKILL, not the app's own force-exit, is the effective ceiling on shutdown time in
production, and it is half of what the app internally assumes it has before it force-exits itself.
This is a real mismatch in the current configuration, documented here rather than fixed (see
"Known failure modes").

## Resource limits
- `BODY_LIMIT` (default `65536` bytes): Fastify `bodyLimit`, enforced on every request — confirmed
  in `app.test.js` (`413` on an oversized body).
- `WORKER_CONCURRENCY` (default `5`): maximum messages claimed and delivered concurrently per
  worker pass (`queue.claim(concurrency)`).
- List page size: `GET /v1/messages` `limit` query param, schema-restricted to `1`–`100`, defaults
  to `20` in the handler when omitted.
- `max_memory_restart: '300M'` in `ecosystem.config.cjs` — PM2 restarts the process if its RSS
  exceeds 300 MB.
- Webhook custom headers: at most 10 properties, each value at most 1024 characters, names
  restricted to `X-*` or `Authorization` (schema in `src/app.js`).
- Email address lists (`to`/`cc`/`bcc`): at most 10 addresses each.

## Timeouts
- `WEBHOOK_TIMEOUT_MS` (default `10_000` ms, min `1000`, max `lockTtlMs / 2`): Node
  `http`/`https` request timeout for an outbound webhook POST. On fire: `WebhookError` with
  `retryable: true`, `code: 'TIMEOUT'` — retried per the backoff policy.
- SMTP transport (real SMTP only, not `json:`): `connectionTimeout` 10 000 ms, `greetingTimeout`
  10 000 ms, `socketTimeout` 30 000 ms — all hardcoded in `EmailChannel.createTransport`, not
  environment-configurable. A timeout surfaces from nodemailer without a numeric `responseCode`,
  so `EmailChannel.isRetryable()` treats it as retryable (its default when the code isn't a
  number).
- Audit forwarding: `timeoutMs` defaults to `5_000` ms per HTTP call to the audit service
  (`AbortSignal.timeout`) — a constructor default in `AuditClient`, not wired to any env var from
  `Application` (only `target` is passed in; `flushMs`=2000, `batchSize`=200 and `timeoutMs`=5000
  all stay at their built-in defaults today).
- `LOCK_TTL_MS` (default `120_000` ms): how long a claimed (`processing`) message may stay locked
  before the worker's periodic maintenance (`reapStale`) returns it to the queue as if the worker
  had crashed mid-delivery. It also backs the graceful-shutdown force-exit delay (see above) — one
  env var serving two purposes.

## Retry policy
- **Queued deliveries** (`src/queue.js`, `Backoff` class + `Queue.markFailure`): exponential
  backoff with **equal jitter** — `delay = half + random() * half`, where `half = min(capMs, baseMs
  * 2^(attempt-1)) / 2`. Defaults: `BACKOFF_BASE_MS=5000`, `BACKOFF_CAP_MS=3_600_000` (1 hour cap).
  Maximum attempts: `MAX_ATTEMPTS` (default `8`), tracked per row as `attempts`/`max_attempts`;
  once attempts reach the max, or a channel marks the failure non-retryable, the row moves to
  `failed` and stops being claimed. Jitter is always on; there is no jitter-free mode.
- **Audit forwarding** (`src/net/audit-client.js`, `#send`): a separate, simpler scheme — up to
  `AuditClient.MAX_ATTEMPTS = 6` attempts per batch, with a sleep before every retry (not the
  first) of `min(30_000, 500 * 2^attempt)` ms (roughly 1 s, 2 s, 4 s, 8 s, 16 s, capped at 30 s) —
  no jitter. A batch still failing after 6 attempts is left in the buffer for the next scheduled
  flush (every `flushMs` = 2000 ms by default) rather than dropped; it is only dropped outright on
  a definitive non-429 4xx response from the audit service.
- **Manual retry** (`POST /v1/messages/:id/retry`): resets `attempts` to `0` and `status` to
  `queued` immediately — bypasses backoff for the next attempt. Only allowed from the `failed`
  state (`409` otherwise).

## Idempotency
- `POST /v1/messages` **with** `idempotencyKey`: safe to repeat. Enforced by a real database
  constraint (`UNIQUE INDEX messages_idempotency ON messages (api_key_id, idempotency_key) WHERE
  idempotency_key IS NOT NULL`); the insert uses `ON CONFLICT ... DO NOTHING` and then re-reads the
  existing row (`Queue.enqueue`), verified by `queue.test.js`. **Without** `idempotencyKey`, two
  identical POSTs create two separate messages — not idempotent by design; the API does not
  pretend otherwise.
- `GET /v1/messages`, `GET /v1/messages/:id`, `GET /v1/templates`: naturally idempotent reads.
- `POST /v1/messages/:id/retry`: **not** safe to repeat in the sense of "fire twice, same effect."
  It is guarded by state (`409` unless the message is currently `failed`), but each successful call
  starts a fresh delivery cycle; calling it repeatedly across failure cycles can trigger further
  delivery attempts each time. There is no dedup token on retry the way there is on creation — a
  real gap, stated plainly rather than implied safe.
- Actual delivery (SMTP send / webhook POST): not idempotent from the receiver's perspective. A
  retry after an ambiguous outcome (e.g. the SMTP server accepted before the socket closed, or a
  webhook receiver processed the request but the response timed out) can produce a duplicate send.
  The only correlation token offered to receivers is the `X-Notify-Id` header — deduplication on
  that id is the receiver's responsibility, not something `notify` enforces.

## Backup
State that needs to survive a disk loss: the single SQLite file at `DB_PATH` (plus its `-wal`/
`-shm` companions while WAL mode is active). There is no backup mechanism in the codebase today —
no dump script, no scheduled snapshot. Capturing it today means an operator stopping the process
(or using SQLite's own online-backup facility / `.backup` via the `sqlite3` CLI, or checkpointing
the WAL first) and copying the file themselves; nothing here automates it.

## Restore
No restore tooling exists in the codebase either. The exact steps today: stop the `notify` process
(`pm2 stop notify`), replace `DB_PATH` (and any `-wal`/`-shm` files) with the backup copy, restart
(`pm2 start`/`pm2 restart`). There is no ordering constraint with other services' data — `notify`
does not embed foreign keys or references that require another service's data to be restored
first or in lockstep; `api_key_id` on each row is just the caller's own key id, not a reference
into another service's database.

## Metrics
`GET /metrics` (bearer-auth, same as `/v1`), Prometheus text exposition format. Exposes:
- `notify_messages{status="queued|processing|sent|failed"}` — **durable**, computed live via
  `Queue.stats()` (`SELECT status, COUNT(*) ... GROUP BY status` against the database), so it
  reflects real persisted state and survives a restart.
- `notify_oldest_queued_age_seconds` — **durable**, derived from `MIN(next_attempt_at)` over
  queued rows in the database.
- `notify_process_uptime_seconds` — **per-process**, `process.uptime()`, resets to zero on every
  restart.

`AuditClient.stats` (`recorded`/`sent`/`dropped`/`failed`) exists as an in-memory object on the
audit client but is **not** exposed on `/metrics` today — it is only reachable in-process (and in
tests), so it is neither durable nor currently surfaced as a metric at all.

## Logging
Fastify's default structured request logging is active (`config.logLevel`, or an injected
`loggerInstance`), with `req.headers.authorization` redacted. `requestIdHeader: 'x-request-id'` is
set in `src/app.js`, so per the vocabulary in
[OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md), `notify` emits `reqId` on every request log
line, accepting whatever `X-Request-Id` a caller sends and generating one via `randomUUID()` only
when absent — this is unconditional and predates this review, not new behaviour. Worker and
delivery logs add their own structured fields (`messageId`, `channel`, `attempt`, `durationMs`,
`providerId`/`err`/`status`/`nextAttemptAt` in `src/worker.js`), but these are ad hoc per-call
field names rather than the OBSERVABILITY.md vocabulary, even where a name happens to coincide
(`durationMs` here is manually computed in `worker.js`, not Fastify's own `responseTime`, which is
what the vocabulary treats as the equivalent field for HTTP requests).

Fields from the OBSERVABILITY.md vocabulary that `notify` does **not** yet emit: `traceId`,
`spanId`, a normalised `route`/`op` (only Fastify's implicit `req.url` is available), `upstream` /
`upstreamMs` (`notify` doesn't proxy), `service`, `version`, and `code` (present in the HTTP error
body but not echoed into the log line itself).

## Tracing
`notify` does not parse, generate, or forward `traceparent`. Per OBSERVABILITY.md, that is
implemented only in the `gateway` service as of this review's Stage 1; `notify` makes no claim to
it. `notify` does already accept and log an inbound `X-Request-Id` (`requestIdHeader:
'x-request-id'` in `src/app.js`, confirmed by reading the file in this session) — unconditionally,
with no trust-boundary gate, because `notify` is only ever reached from other internal services,
never directly from an untrusted client.

Outbound, `notify`'s own calls do not forward either header onward:
- SMTP send (`src/channels/email.js`): no request-id or trace header of any kind is attached to
  the outbound mail; nodemailer's headers option only carries `X-Notify-Id` (the message id).
- Webhook POST (`src/channels/webhook.js`): headers sent are `content-type`, `content-length`,
  `user-agent`, `x-notify-id`, `x-notify-event` and the HMAC signature header — no
  `X-Request-Id`/`traceparent`.
- Audit forwarding (`src/net/audit-client.js`): the HTTP call to the audit service only sets
  `authorization` and `content-type` headers — no `X-Request-Id` is propagated as a header. The
  audit *event payload* does carry a `requestId` field (taken from `request.id`), but that travels
  inside the JSON body, not as a header on the wire.

## Security model
Bearer API keys only (`NOTIFY_API_KEYS`, `id:secret` pairs; each secret must be at least 32
characters, enforced at config load). Every configured key is checked in constant time regardless
of whether it matches — `ApiKeyAuth.#secretsEqual` hashes both sides with SHA-256 and compares with
`timingSafeEqual`, and the identification loop does not short-circuit on a match — so timing
reveals neither whether nor which key matched. No roles or scopes: a valid key can create, list,
get and retry messages (all scoped to its own `api_key_id`) and can also read `/metrics`; there is
no separate read-only vs. write-capable key type. Rotation: no dedicated mechanism — rotating a key
means editing `NOTIFY_API_KEYS` and restarting or reloading the process; there is no live rotation,
per-key expiry, or revocation list. Boundary validation: JSON Schema on every request body with
`additionalProperties: false` (unknown fields rejected, not silently stripped —
`removeAdditional: false`), email/URL/UUID format checks, a webhook header name/value allowlist,
and per-template `data` validated against that template's own compiled schema. Explicitly out of
scope, per the README's "Out of scope by design": SMS/push channels and attachments; key rotation
tooling and RBAC are absent but not explicitly called out there either — noted here instead.

## Scaling model
**B — single-node stateful.** One process owns one SQLite (`node:sqlite`) file at `DB_PATH`.
`ecosystem.config.cjs` hardcodes `instances: 1`, with a comment explaining why: "one process per
SQLite file; the delivery worker runs in-process." Two instances pointed at the same file: message
claiming itself would not double-deliver — `Queue.claim()` is a single atomic `UPDATE ... WHERE id
IN (SELECT ...) RETURNING`, and SQLite serializes writers (with `busy_timeout=5000` absorbing brief
contention), a point the README already makes ("claims are atomic, so it works, but the intended
deployment is one instance per database"). What is *not* safe or coordinated: two processes racing
`#migrate()` on a brand-new database file at simultaneous first boot (no lock around it), and two
processes both running the 60-second maintenance pass (`reapStale`/`purge`) redundantly against the
same file — harmless but wasted work, not a supported scale-out path. Real horizontal scaling needs
a server database, as the README already states ("Move to Postgres if you need horizontal
scaling").

## Single-node / multi-node guarantees
Running the documented single instance: full guarantees hold — atomic claim (no double-delivery
via the claim mechanism itself, modulo the stale-lock reap window described in "Known failure
modes"), idempotency-key dedup on creation, and consistent retry/backoff state.

Running more than one instance against the same `DB_PATH` file is not structurally prevented by the
code, though it is not the documented deployment. If it happened: claims still would not
double-deliver the same row (the atomic `UPDATE ... RETURNING` guarantees that), but there is no
additional coordination beyond that — no leader election, no per-instance lease beyond the
row-level `locked_until`. Both instances would compete for the same claim batches (wasted work, not
corruption), both would run maintenance redundantly, and a simultaneous first boot against a new,
empty database file would race the migration step unguarded.

## Known failure modes
- **Disk full.** A SQLite write (`INSERT`/`UPDATE`, including a WAL checkpoint) throws from
  `node:sqlite`'s `DatabaseSync`. On the HTTP path this reaches `NotifyApi`'s generic error handler
  (`status >= 500`, logged as `unhandled error`, `INTERNAL_ERROR` returned). On the worker path,
  `Worker#deliver`'s `try/catch` wraps `channel.deliver()` and, in the failure branch, the
  `queue.markFailure()` call that records the outcome — so a disk-full error *while recording a
  failed delivery* propagates up out of `#deliver` entirely, uncaught inside that method, and is
  only caught by `#run()`'s own top-level `try/catch` (logged as `worker iteration failed`, loop
  continues). The practical effect: that message's in-memory delivery outcome for that attempt is
  lost — it stays `processing` until its lock expires and `reapStale` returns it to the queue,
  which can mean an actually-successful email or webhook gets retried.
- **A dependency times out mid-request.** For SMTP/webhook: handled as designed — classified
  retryable or not per channel, backoff applied (see worker.test.js's `/slow` and permanent-vs-
  transient cases). For the audit service: no impact on the business request at all, since
  `record()` only appends to an in-memory buffer synchronously; the network call happens later, off
  the request path.
- **The process is killed without a graceful shutdown** — SIGKILL, an OOM restart via
  `max_memory_restart`, or (see "Graceful shutdown" above) PM2's `kill_timeout` (60 s) elapsing
  before the app's own internal force-exit (`LOCK_TTL_MS`, default 120 s) would have fired. Any
  message still `processing` at the moment of the kill stays stuck in `processing` — not retried,
  not visible as failed — until the next process start calls `reapStale()`, or a running instance's
  own periodic maintenance reaches it, up to `LOCK_TTL_MS` after the crash. Any audit events still
  sitting in `AuditClient.buffer` (unflushed, capacity `MAX_BUFFER` = 5000) are lost outright: the
  buffer is in-memory only, never persisted to disk.
- **Two instances run against one file.** As above: no corruption from double-delivery, but
  duplicated/wasted maintenance work every 60 s from both instances, and an unguarded migration
  race if both start against a brand-new, empty database file at the same instant.
