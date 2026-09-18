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

Schema: `messages` — `id` (PK), `api_key_id`, `idempotency_key`, `channel`
(`email`/`webhook`), `payload` (JSON text), `status` (`queued`/`processing`/`sent`/`failed`),
`attempts`, `max_attempts`, `next_attempt_at`, `locked_until`, `last_error`, `provider_id`,
`created_at`, `updated_at`, `sent_at`, and, since Stage 6, `owner_token` (the fencing token of
whoever currently holds the lock; null when not `processing`). Four indexes: a unique index on
`(api_key_id, idempotency_key)` where the key is not null (idempotency enforcement), `(status,
next_attempt_at)` for claiming due work, `(api_key_id, created_at DESC, id DESC)` for listing, and
`(status, updated_at)` for the retention purge scan. A second migration (Stage 6) adds
`owner_token` and a new `worker_heartbeat` table — one row per live worker process (`instance`
primary key, `seen_at`), written on a timer by any process running a `Worker` loop and read by an
API-only process's `/ready` and `/metrics` in place of the in-process `Worker` object it doesn't
have.

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
re-probing. Returns `200 {status:'ok', worker:'running'|'stopped'}` when the cached check passed,
`503 {status:'unavailable', error}` when it last failed. Safe to poll: no state mutation, nothing
discarded — the only side effect is, at most once per 30 s, a DB read and an SMTP handshake
attempt, neither of which writes to the `messages` table or touches queued work.

The `worker` field (Stage 6) is DB-backed in every role, unlike `scheduler`/`webhook-out`: notify's
readiness/stats never read an in-process `Worker` field even before this stage, so there was no
role-dependent branch to add — `NotifyApi#workerStatus()` always reads the `worker_heartbeat`
table's most recent row and reports `"running"` when it is fresher than `HEARTBEAT_MS * 4`
(`NotifyApi.PRESENCE_STALE_FACTOR`), `"stopped"` otherwise (including "no worker has ever reported
in this database").

## Graceful shutdown
Signals: `SIGTERM` and `SIGINT` both call `Application#shutdown(reason)`; `unhandledRejection`
logs fatal and also calls `shutdown()`; `uncaughtException` calls `process.exit(1)` directly with
no graceful path. `shutdown()` is guarded by a `shuttingDown` flag, so a second signal is a no-op.

Order, as written in `src/application.js` (Stage 6 fixed this order — see below for what it was and
why):
1. `this.worker?.stopClaiming()` — flips a flag `#pass()` checks before claiming new messages;
   whatever is already in flight keeps running. Present only when this process runs a worker at
   all (skipped in the API-only role, which has no `Worker`).
2. `await this.app?.close()` — Fastify stops accepting new connections and runs its own close
   lifecycle. Present only in the API and combined roles.
3. `await this.worker?.stop()` — (redundant `running = false`) awaits the worker's in-flight loop
   promise and every in-flight send (`Promise.allSettled(this.inFlight)`), clearing each one's
   heartbeat interval as it settles. Stage 6.1: this wait is itself bounded by `options.drainMs` —
   races `Promise.allSettled(inFlight)` against a `sleep(drainMs)`, cancelled via `AbortController`
   so the loser doesn't leak a timer. On timeout it logs `'drain timed out; continuing shutdown
   with sends still in flight'` and falls through to the remaining steps instead of hanging.
4. `for (const ch of this.channels) ch.close()` — `EmailChannel` closes its pooled SMTP
   connections; `WebhookChannel` has no `close()` override, so it's a no-op.
5. `await this.audit.close()` — stops the flush timer and performs one final `flush()`, using the
   same retry/backoff as a normal flush.
6. `this.db.close()`.

**Before Stage 6** step 5 (audit flush) was step 2, running *before* the worker drained — see
`scheduler`'s identical fix for the general reasoning (a message finishing during drain and
needing to record an audit event could queue it into an already-flushed, already-stopped buffer).

On success: `process.exit(0)`. Force-exit timeout: a `setTimeout(...).unref()` set to
`callCeilingMs + 10_000`, where `callCeilingMs = Math.max(EmailChannel.SMTP_WORST_CASE_MS,
config.webhookTimeoutMs)` — default `Math.max(50_000, 10_000) + 10_000 = 60_000` ms. The worker's
own `drainMs` (previous step) uses the same `callCeilingMs`, plus a smaller margin:
`callCeilingMs + 5_000` — default `55_000` ms — so the drain timeout always fires first and the
remaining shutdown steps (channel close, audit flush, DB close) get a chance to run before the
force-exit timer hard-kills the process.

**Stage 6.1 fix**: before this stage, `forceExitMs` was `config.lockTtlMs + 10_000` — the lease
TTL, not the call duration. That was sound before the heartbeat existed (a send could never
outlive its own lease), but the heartbeat decouples the two: a legitimate SMTP/webhook call can now
run far longer than `LOCK_TTL_MS` as long as it keeps renewing the lease, so bounding shutdown by
`LOCK_TTL_MS` risked force-exiting mid-call on a perfectly healthy, still-heartbeating send.
`EmailChannel.SMTP_WORST_CASE_MS` (`connectionTimeout + greetingTimeout + socketTimeout` from
`createTransport`, `= 50_000`) and `config.webhookTimeoutMs` are the real ceilings on how long one
external call can legitimately take, so `callCeilingMs` replaces `lockTtlMs` as the basis for both
`drainMs` and `forceExitMs`.

Comparison with PM2: `notify/ecosystem.config.cjs` sets `kill_timeout: 150000` (150 s; was `630000`,
sized for the old `lockTtlMs`-based formula and left comfortably oversized once `forceExitMs`
dropped to a call-duration basis). `150_000 = max(SMTP_WORST_CASE_MS=50_000,
WEBHOOK_TIMEOUT_MS max 120_000) + 10_000 (force-exit margin) = 130_000`, plus `20_000` headroom —
comfortably above the worst-case force-exit timer regardless of how `WEBHOOK_TIMEOUT_MS` is
configured within its validated range.

The five numbers that matter for notify's shutdown, in the same relationship as `scheduler` and
`webhook-out`: worker drain timeout (`drainMs = callCeilingMs + 5_000`); the external call's own
timeout ceiling (`callCeilingMs`, the larger of the SMTP worst case and `WEBHOOK_TIMEOUT_MS`); the
heartbeat interval (`HEARTBEAT_MS`) that renews a lease during an in-flight call; the lease TTL
(`LOCK_TTL_MS`), now fully decoupled from call duration by the heartbeat; and PM2's `kill_timeout`
(150 s), which sits above the app's own force-exit timer so PM2 never SIGKILLs before the app has a
chance to exit on its own.

## Resource limits
- `BODY_LIMIT` (default `65536` bytes): Fastify `bodyLimit`, enforced on every request — confirmed
  in `app.test.js` (`413` on an oversized body).
- `WORKER_CONCURRENCY` (default `5`): maximum messages in flight at once, via a rolling pool
  (`inFlight` `Set`) — Stage 6 fix. Before Stage 6 this was a fixed batch awaited with
  `Promise.all`: claiming `concurrency` messages together and not claiming more until the whole
  batch settled, so one slow send idled the rest of the pool's slots until it finished. The rolling
  pool claims a replacement as soon as any individual send's own promise resolves.
- List page size: `GET /v1/messages` `limit` query param, schema-restricted to `1`–`100`, defaults
  to `20` in the handler when omitted.
- `max_memory_restart: '300M'` in `ecosystem.config.cjs` — PM2 restarts the process if its RSS
  exceeds 300 MB.
- Webhook custom headers: at most 10 properties, each value at most 1024 characters, names
  restricted to `X-*` or `Authorization` (schema in `src/app.js`).
- Email address lists (`to`/`cc`/`bcc`): at most 10 addresses each.

## Timeouts
- `WEBHOOK_TIMEOUT_MS` (default `10_000` ms, min `1000`, max `120_000` — Stage 6 changed the cap
  from `lockTtlMs / 2` to a fixed ceiling): Node `http`/`https` request timeout for an outbound
  webhook POST. On fire: `WebhookError` with `retryable: true`, `code: 'TIMEOUT'` — retried per the
  backoff policy. The old cap existed because a send lasting more than half the lock's TTL risked
  losing the lock before it could finish (there was no heartbeat to renew it); the heartbeat
  (`HEARTBEAT_MS`, below) now protects a long send regardless of how `WEBHOOK_TIMEOUT_MS` and
  `LOCK_TTL_MS` relate to each other, so the two no longer need to be coupled.
- SMTP transport (real SMTP only, not `json:`): `connectionTimeout` 10 000 ms, `greetingTimeout`
  10 000 ms, `socketTimeout` 30 000 ms — all hardcoded in `EmailChannel.createTransport`, not
  environment-configurable. A timeout surfaces from nodemailer without a numeric `responseCode`,
  so `EmailChannel.isRetryable()` treats it as retryable (its default when the code isn't a
  number).
- Audit forwarding: `timeoutMs` defaults to `5_000` ms per HTTP call to the audit service
  (`AbortSignal.timeout`) — a constructor default in `AuditClient`, not wired to any env var from
  `Application` (only `target` is passed in; `flushMs`=2000, `batchSize`=200 and `timeoutMs`=5000
  all stay at their built-in defaults today).
- `LOCK_TTL_MS` (default `120_000` ms, range `5_000`–`600_000`, upper bound added in Stage 6): how
  long a claimed (`processing`) message's lease lasts without a heartbeat before it becomes
  reclaimable as a failed attempt (`Queue#reclaimExpired`, previously `reapStale`'s unconditional
  free reset). It also backs the graceful-shutdown force-exit delay (see above) — one env var
  serving two purposes, unchanged from before Stage 6.
- `HEARTBEAT_MS` (default `10_000` ms, `min` 250, must be `< LOCK_TTL_MS`) — Stage 6. How often an
  in-flight send's lock is renewed (`Worker#execute`'s `setInterval`, cleared once the send
  settles). Deliberately independent of `WEBHOOK_TIMEOUT_MS`/SMTP's own hardcoded timeouts — a send
  can run far longer than `LOCK_TTL_MS` without losing its lock, as long as its heartbeat keeps
  succeeding. See "Lease ownership".

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
- `POST /v1/messages` **with** `idempotencyKey`, same channel and payload as the original: safe to
  repeat. Enforced by a real database constraint (`UNIQUE INDEX messages_idempotency ON messages
  (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL`); the insert uses `ON CONFLICT
  ... DO NOTHING` and then re-reads the existing row (`Queue.enqueue`), verified by
  `queue.test.js`.
- `POST /v1/messages` **with** the same `idempotencyKey` but a DIFFERENT channel or payload: Stage
  6 fix — `409 IDEMPOTENCY_CONFLICT` (`IdempotencyConflictError`), not a silent `200` with the
  stale original content. Before Stage 6, `enqueue()` never compared the replay's payload against
  the stored row at all, so a key reused for a different send would appear to succeed while
  actually sending nothing new — a caller could not tell it happened. Comparison is exact
  `JSON.stringify` equality of the stored vs. incoming payload, not a deep-equal — a byte-identical
  re-send (the common case: the same call retried) always matches; a semantically-equal but
  differently-ordered object would not, which is an intentional simplicity trade-off, not a
  correctness gap for the retry-safety this exists for.
- **Without** `idempotencyKey`, two identical POSTs create two separate messages — not idempotent
  by design; the API does not pretend otherwise.
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
implemented in the `gateway` and `console` services (Stage 10); `notify` makes no claim to
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

## API/worker runtime split
Stage 6 adds two more entry points alongside the default combined one — `src/api-main.js` (HTTP
only, no `Worker`, never claims a message) and `src/worker-main.js` (`Worker` only, no HTTP
listener at all). `Application`'s `role` constructor option (`'combined'` default, `'api'`,
`'worker'`) picks which parts get built; `Config`, the database, and the migrations are identical
across all three. `ecosystem.config.cjs` ships the split apps commented out, ready to enable.

## Lease ownership
Every claimed batch of messages gets, in addition to `status = 'processing'`: **`owner_token`** — a
fresh random value per `claim()` *call* (not per row: the whole batch shares one token, since every
fencing check is already scoped by `id` in its `WHERE` clause, so a shared token is exactly as safe
as a per-row one and simpler) — and **`locked_until`**, renewed every `HEARTBEAT_MS` while a send
is in flight. `Queue#markSent`/`Queue#markFailure` are guarded by `WHERE id = ? AND owner_token = ?
AND status = 'processing'`, so a worker that hung long enough to be reclaimed by someone else can
never overwrite the row when it eventually returns. `Queue#reclaimExpired` (called by
`Worker#recover()` at startup, labeled `"interrupted by restart"`, and by the in-loop
`#reclaimStale()` on every poll pass, labeled `"lease expired"`) reads every row whose lock is
strictly expired — `locked_until < now`, so `now == locked_until` is NOT yet expired, the same
invariant as claim/heartbeat/finish (Stage 6.1 regression test: `test/queue.test.js`'s
`reclaimExpired` boundary assertions) — inside one transaction with every write, the same
race-free construction as `scheduler`'s identical primitive (see its README for the full "why one
transaction" reasoning). What it does with each expired row now depends on `call_started_at`
(Stage 6.1, `messages.call_started_at`, set by `Worker#deliver()` right before the channel's
`deliver()` call, cleared on every write leaving `'processing'`):
- **`call_started_at IS NULL`** — the process never reached the delivery-attempt boundary at all;
  an infra-only crash between claim and that point (process killed, container rescheduled, etc.)
  with the message never actually attempted. Released back to `'queued'` for free —
  `next_attempt_at = now` (immediately due again, no backoff) and **no attempt cost** — via the
  same fencing-guarded release path `#release()` uses internally.
- **`call_started_at` is set** — the process crossed the delivery-attempt boundary; its outcome is
  unknown. Settled as a failed attempt through the same `markFailure` path an ordinary send failure
  uses — it costs an attempt and follows the normal backoff/exhaustion schedule, exactly as before
  Stage 6.1.

**Stage 6.2 correction — what `call_started_at IS NOT NULL` does and does not prove**: the write
happens right before `Worker#deliver()` invokes `channel.deliver()`, not right after. A non-NULL
value proves the process reached that line; it does NOT prove the external SMTP send or webhook
POST itself ever started — the process can still crash in the gap between the `call_started_at`
write committing and `channel.deliver()` actually running. That gap is deliberately folded into the
"real attempt" bucket rather than given a third state: the column marks "attempt intent recorded,
external outcome unknown," and counting it as a real attempt is a conservative choice (it may cost
budget for a send that never actually went out), not a claim that delivery definitely began.

**What changed from before Stage 6**: `reapStale()` reset every expired-lock row straight back to
`queued` for free, with no attempt cost and no fencing check on the row it touched (there was no
`owner_token` at all). A worker that crashed repeatedly on the same message could have it reaped
and reclaimed indefinitely without `max_attempts` ever being enforced against that path — only
against genuine send failures. `reclaimExpired` closes that gap by routing reclaim through the same
attempt-counting path as any other failure — **unconditionally**, at the time.

**What changed again in Stage 6.1**: routing every reclaim through `markFailure` unconditionally was
itself a real gap in the other direction — a process that crashes repeatedly right after claiming a
message, before ever reaching the delivery-attempt boundary, could exhaust `max_attempts` on pure
infrastructure churn with the message never actually sent once. `call_started_at` draws the line:
"claimed" alone costs nothing; crossing the delivery-attempt boundary is what counts as a real
attempt. This still does not claim exactly-once delivery in either direction — a message can be
sent more than once (the external call actually succeeded, then the process died before the `sent`
write landed), or, in the conservative case above, retried once for a send whose external call
never actually ran. Stage 6.1/6.2 only guarantee retry budget is never consumed by a crash that
never reached the delivery-attempt boundary at all.

## Scaling model
**B — single-node stateful, but "single-node" now means one HOST, not one PROCESS.** One SQLite
(`node:sqlite`) file at `DB_PATH`. `ecosystem.config.cjs`'s default (combined) app still pins
`instances: 1`, but the commented-out split `notify-worker` app documents raising its own
`instances` above 1 as a supported topology.

Two (or more) worker processes pointed at the same file: message claiming itself does not
double-deliver — `Queue.claim()` is a single atomic `UPDATE ... WHERE id IN (SELECT ...)
RETURNING`, proven with real cross-connection concurrency (not same-process `Promise.all`) in
`test/lease-concurrency.test.js` — and the lease/fencing model above means a crash in one worker is
reclaimed by any live sibling's next poll pass. What is *still* not coordinated: two processes
racing `#migrate()` on a brand-new database file at simultaneous first boot (no lock around it) —
an operational concern for the very first start of a fresh deployment, not an ongoing runtime one.
Real horizontal scaling across *hosts* still needs a server database, as the README states.

## Single-node / multi-node guarantees
Running the documented single (combined) instance: full guarantees hold as always. Running several
worker processes against the same `DB_PATH` file (Stage 6's split-deployment topology) is now a
supported configuration: claims still never double-deliver the same row, and a crash in one worker
is now reclaimed by any live sibling, not only by that same process restarting — the difference
Stage 6 makes. Both/all instances compete for the same claim batches under real SQLite write-lock
serialization (not corruption, just contention under very high claim rates), and a simultaneous
first boot against a brand-new, empty database file still races the migration step unguarded — start
one instance first, let it complete its migration, before scaling out workers against that file.

## Known failure modes
- **Disk full.** A SQLite write (`INSERT`/`UPDATE`, including a WAL checkpoint) throws from
  `node:sqlite`'s `DatabaseSync`. On the HTTP path this reaches `NotifyApi`'s generic error handler
  (`status >= 500`, logged as `unhandled error`, `INTERNAL_ERROR` returned). On the worker path
  (Stage 6 restructured `#execute`/`#deliver`, but the shape of this risk is unchanged): the single
  `queue.markSent`/`queue.markFailure` write that records an attempt's outcome can itself throw,
  uncaught inside `#execute`, propagating to whichever `Promise.allSettled`/loop-level handling
  observes it — the practical effect is the same as before: that attempt's outcome is lost, the
  message stays `processing` until its lock expires and gets reclaimed, which can mean an
  actually-successful send gets retried.
- **Heartbeat failure while a send is genuinely still in flight** (event loop stall, a slow/busy DB
  write for the heartbeat `UPDATE` itself): Stage 6. The heartbeat's own guarded write detects the
  lost lock and logs a warning immediately, but cannot cancel the outbound SMTP/HTTP call already
  in progress. If the lock then expires and another process reclaims the message, the original
  call's eventual `markSent`/`markFailure` is rejected by the same `owner_token`/`status` guard
  (logged, not thrown) — its result is discarded, and the reclaim's own "lease expired" failed-
  attempt outcome is what stands. A genuinely successful send whose heartbeat failed can be
  silently wasted from the recipient's point of view and retried.
- **A dependency times out mid-request.** Unchanged: for SMTP/webhook, handled as designed —
  classified retryable or not per channel, backoff applied. For the audit service: no impact on the
  business request at all, since `record()` only appends to an in-memory buffer synchronously.
- **The process is killed without a graceful shutdown** — SIGKILL, an OOM restart via
  `max_memory_restart`. Any message still `processing` at the moment of the kill is no longer stuck
  until the *same* process restarts: since Stage 6, the in-loop `#reclaimStale()` sweep reclaims it
  on the next poll pass of *any* live worker process (this one restarting, or a sibling in a
  multi-worker deployment), at most `LOCK_TTL_MS` after the kill. Any audit events still sitting in
  `AuditClient.buffer` (unflushed, capacity `MAX_BUFFER` = 5000) are still lost outright either
  way — the buffer is in-memory only, never persisted to disk; unaffected by Stage 6.
- **Multiple worker processes running against one file.** Stage 6: now a supported topology (see
  "Scaling model"), not a failure mode — listed here only to be explicit that it no longer is one.
  The remaining, expected cost under high contention is write-lock contention
  (`busy_timeout = 5000` ms), and an unguarded migration race specifically at simultaneous first
  boot against a brand-new database file (see "Scaling model").
