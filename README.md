# notify

Queued, retried notification delivery over HTTP. Other services enqueue a message; `notify` renders it, delivers it (email over SMTP, or a signed webhook) and keeps a delivery record.

Runtime dependencies: `fastify`, `@fastify/rate-limit`, `nodemailer`. Storage is SQLite via `node:sqlite` (built into Node 22.13+, no native build). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # fill in keys and SMTP
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`, so no dotenv package):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup        # survive reboots
pm2 reload notify              # restart after a deploy: waits for the app's ready signal
```

`kill_timeout` is 150 s so in-flight deliveries finish before PM2 escalates to SIGKILL. Keep `instances: 1`: the delivery worker runs in-process and one SQLite file expects one writer.

Production with Docker:

```bash
docker build -t atc-notify .
docker run -p 3001:3001 -v notify-data:/data --env-file .env atc-notify
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Boundaries

**Purpose:** fire-and-forget delivery of transactional notifications — templated email, and a legacy one-off signed webhook — on behalf of other services.

**Responsibilities:** template rendering; SMTP delivery with retry/backoff; a legacy signed-webhook channel for one-off calls (`NOTIFY_WEBHOOK_CHANNEL`, see below); idempotency-key dedup; per-message delivery status.

**Non-responsibilities:** notify ≠ durable webhook platform. Its webhook channel is explicitly a legacy path for simple one-off calls — it has no subscription model, no secret rotation, no replay, no delivery history browsing beyond a single message's own status. New durable/retry-oriented webhook integrations belong in `webhook-out`, not here. Notify also does not manage recipient subscriptions or preferences — every send is caller-supplied, per message.

## Running on its own server

Callers reach the service over HTTPS with a bearer key. Two options:

- Reverse proxy (nginx, Caddy) terminates TLS and forwards to `PORT`. Set `TRUST_PROXY=true` so rate limiting sees the real client address.
- Native TLS: set `TLS_CERT_PATH` and `TLS_KEY_PATH` (PEM). The service then listens with HTTPS directly, TLS 1.2 minimum.

Firewall the port to the hosts that call it. Give each calling service its own entry in `NOTIFY_API_KEYS` so keys can be rotated one at a time. Callers configure `NOTIFY_URL` and `NOTIFY_API_KEY` in their own environment.

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md).

## Configuration

All settings come from environment variables and are validated at startup; the process exits with a clear message on a bad value. See [.env.example](.env.example) for the full list and defaults.

Required: `NOTIFY_API_KEYS`, `SMTP_URL`, `SMTP_FROM`, `WEBHOOK_SIGNING_SECRET`.

- `NOTIFY_API_KEYS` is `id:secret,id:secret`. Each secret must be at least 32 characters. The id scopes messages: a caller only sees messages it created.
- `SMTP_URL` is a nodemailer connection URL such as `smtps://user:pass@host:465`. `json:` logs mails instead of sending (development).
- `TLS_CERT_PATH` / `TLS_KEY_PATH` enable native HTTPS; both or neither.
- `WEBHOOK_ALLOWED_HOSTS` restricts webhook targets to the listed hosts and their subdomains. Leave empty to allow any public host.
- `NOTIFY_WEBHOOK_CHANNEL` (default `true`) — turns the legacy signed-webhook channel off when set to `false`. Existing deployments are unaffected by default. When `false`: `POST /v1/messages` with `channel: "webhook"` is rejected with `403 WEBHOOK_CHANNEL_DISABLED` before it's queued; email is unaffected. Anything already `queued`/`processing` under the webhook channel at the moment it's disabled is still claimed by the worker on its normal schedule, but settles to a deterministic terminal `failed` (one attempt cost, no backoff, `last_error` names the reason) instead of attempting delivery or sitting stuck forever — never a silent drop, never an infinite retry loop. New durable/retry-oriented webhook integrations should use `webhook-out` instead of turning this back on.

## API

Every `/v1` and `/metrics` request needs `Authorization: Bearer <secret>`. Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. No auth. |
| GET | `/ready` | Readiness: database and SMTP reachable (cached 30 s). No auth. |
| GET | `/v1/info` | Service identity: version, API version, real capabilities, schema version, service-core version. No auth. |
| POST | `/v1/messages` | Enqueue. `202` with the message, or `200` on an idempotent replay. |
| GET | `/v1/messages` | List own messages, newest first. Query: `status`, `limit` (1-100), `cursor`. |
| GET | `/v1/messages/:id` | Delivery status. |
| POST | `/v1/messages/:id/retry` | Re-queue a `failed` message. `409` for other states. |
| GET | `/v1/templates` | Email templates with their JSON Schemas. |
| GET | `/metrics` | Prometheus text: messages by status, oldest queued age, uptime. |

### Email

```json
{
  "channel": "email",
  "template": "email-verification",
  "to": ["ali@example.com"],
  "cc": [], "bcc": [], "replyTo": "support@example.com",
  "data": { "appName": "Shop", "verifyUrl": "https://shop.example/v?t=…", "expiresInMinutes": 30, "name": "Ali", "locale": "tr" },
  "idempotencyKey": "signup-42"
}
```

`data` is validated against the template's schema before the message is queued; a mismatch returns `400` with the failing path. Templates ship with the service (`src/templates/`), callers never send HTML. Included templates: `email-verification`, `password-reset`, `generic`. All support `locale: "tr" | "en"` (default `tr`).

Adding a template: subclass `EmailTemplate` in `src/templates/<name>.js` (override `name`, `description`, `schema`, `subject()`, `layout()`) and add an instance in `TemplateRegistry.withDefaults()`. `layout()` returns plain strings; `Layout` escapes every value on output.

### Webhook

**Legacy signed webhook for one-off calls.** This is a simple, one-shot signed POST, not a durable delivery platform — no subscriptions, no secret rotation, no replay, no per-endpoint delivery history. For anything durable/retry-oriented (recurring event delivery to external partners, subscription management, replay), use `webhook-out` instead. Can be turned off entirely with `NOTIFY_WEBHOOK_CHANNEL=false` (see Configuration) without affecting email.

```json
{
  "channel": "webhook",
  "url": "https://api.partner.example/hooks/orders",
  "event": "order.paid",
  "data": { "orderId": 42 },
  "headers": { "X-Tenant": "t1" }
}
```

The receiver gets `POST` with body `{ "id", "event", "timestamp", "data" }` and headers `X-Notify-Id`, `X-Notify-Event`, `X-Notify-Signature: t=<unix seconds>,v1=<hex>`. Verify with `HMAC-SHA256(secret, "<t>.<raw body>")` and reject timestamps older than a few minutes; `verifySignature()` in `src/channels/webhook.js` is a reference implementation. Custom headers are limited to `X-*` and `Authorization`. Redirects are not followed.

### Message lifecycle

`queued` → `processing` → `sent` | `failed`.

- A rolling pool keeps up to `WORKER_CONCURRENCY` messages in flight at any time — a slot freed by one finishing send is refilled immediately, not held idle until a whole claimed batch finishes (Stage 6 fix: was previously `Promise.all` over a fixed batch, so one slow send idled the rest of the pool).
- Failures retry with exponential backoff and jitter (`BACKOFF_BASE_MS` doubling up to `BACKOFF_CAP_MS`) until `MAX_ATTEMPTS`.
- Permanent failures stop immediately: SMTP 5xx replies, webhook 3xx/4xx other than 408/425/429, and any blocked target.
- A message claimed longer than `LOCK_TTL_MS` without a heartbeat (crash, or an event-loop stall long enough to miss every renewal) is reclaimed as a failed attempt — costs an attempt and follows the normal backoff/exhaustion schedule, same as any other failure (Stage 6: previously a free reset with no attempt cost). A heartbeat renews the lock every `HEARTBEAT_MS` while a send is genuinely still in flight, so an ordinary slow send never loses its lock on its own.
- `sent` and `failed` rows are deleted after `RETENTION_DAYS`.
- `idempotencyKey` is unique per API key; a repeat with the SAME channel and payload returns the original message instead of sending twice. A repeat with a DIFFERENT channel or payload is a `409 IDEMPOTENCY_CONFLICT` (Stage 6: previously silently returned the stale original as if it had succeeded) — the key identifies one logical send, not a slot to overwrite.

## Code layout

Class-based; dependencies are injected through constructors, `src/application.js` is the composition root.

| Class | File | Role |
|---|---|---|
| `Application` | `src/application.js` | Wires everything, owns startup and graceful shutdown |
| `Config` | `src/config.js` | Validated environment (`Config.fromEnv()`) |
| `Database` | `src/db.js` | SQLite connection + migrations |
| `Queue`, `Backoff` | `src/queue.js` | Persistent delivery queue, claim/ack/retry SQL |
| `NotifyApi`, `MessageView` | `src/app.js` | Fastify routes, schemas, error mapping |
| `ApiKeyAuth` | `src/auth.js` | Bearer key hook |
| `Worker` | `src/worker.js` | Delivery loop and maintenance |
| `Channel` → `EmailChannel`, `WebhookChannel` | `src/channels/` | Outbound delivery per channel, retry classification |
| `WebhookSigner` | `src/channels/webhook.js` | HMAC signing and verification |
| `NetGuard` | `src/net-guard.js` | SSRF guard with pinned resolution |
| `EmailTemplate` → concrete templates, `Layout`, `TemplateRegistry` | `src/templates/` | Escaped rendering, schema per template |
| `Html` | `src/html.js` | Static escaping helpers |

## Security notes

- **At-least-once delivery, not exactly-once — for both channels, with different guarantees per channel.** For the webhook channel: if the receiver returns `2xx` but this process dies before the message's local `sent` state commits, the same message is retried and the receiver gets the same request again. `X-Notify-Id` is the message's own id and stays identical across every retry of that message; a receiver can use it as an idempotency/deduplication key. (`idempotencyKey`, above, is a separate, caller-facing concept — it dedupes repeat `POST /v1/messages` calls from the API caller before a message is ever queued; it is never sent to the webhook receiver and is not itself a retry-dedup mechanism.) For the SMTP/email channel: the identical crash window exists (SMTP acceptance happens, then the process can die before the local `sent` state commits, causing a resend), but SMTP gives no server-side dedup mechanism to attach to — a duplicate email reaching the same inbox twice is a real possibility this service cannot prevent on its own. `X-Notify-Id` is included in the mail headers for a downstream mail-processing pipeline that chooses to read it, but nothing in the SMTP protocol itself dedupes on it; do not present this as solved.
- API secrets are compared in constant time; every configured key is checked so timing does not reveal which one matched. `WebhookSigner.verify()` (the reference signature-verification helper receivers can use) compares the HMAC digest with `timingSafeEqual`, not a short-circuiting `Buffer.equals` (Stage 6 fix).
- Rate limit per API key (`RATE_LIMIT_MAX` per minute).
- Webhook targets are resolved before connecting and rejected when any address is loopback, private, link-local, multicast, or another special range (IPv4 and IPv6 including mapped, NAT64, 6to4 and Teredo forms). The vetted address is pinned for the connection so DNS rebinding cannot redirect it. `https` only unless `WEBHOOK_ALLOW_HTTP=true`. URLs with credentials are rejected.
- Template data is escaped on output; button URLs must be `http(s)`; subjects are collapsed to one line to prevent header injection.
- Request bodies are capped at `BODY_LIMIT` bytes; unknown fields are rejected.
- Template `data` is never returned by the API (it may contain personal data). Logs redact `Authorization`.
- Container runs as the unprivileged `node` user.

## Out of scope by design

- SMS and push channels: these need a provider account; add a channel module next to `src/channels/` when one is chosen.
- Attachments: the service sends templated messages only. Send a link instead.
- True multi-host distribution: every process (API or worker, however many) must reach the same `DB_PATH` file on one host — there is no network-shared queue. Move to a server database if you need horizontal scaling across hosts.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## API/worker runtime split

`src/index.js` (default) runs both the HTTP API and the worker loop in one process — nothing about
existing single-process deployments changes. Two more entry points exist for a split deployment:
`src/api-main.js` (HTTP only, never claims a message) and `src/worker-main.js` (worker only, no
HTTP listener at all — PM2's own process state is the liveness signal). All three share the same
`Config`, the same database, the same migrations. `npm run api` / `npm run worker` run them
directly; `ecosystem.config.cjs` has the split apps ready to uncomment. `/ready` and `/metrics` were
already DB-backed before this split (never read an in-process `Worker` field); a new
`worker_heartbeat` table adds the one signal that wasn't already there — is a worker alive at all.

## Lease ownership and scaling model

**Scaling class: B — single-node stateful, but "single-node" now means one HOST, not one
PROCESS.** (See `stack/docs/ARCHITECTURE_AUDIT.md` and `stack/docs/READINESS_TEMPLATE.md` for the
class definitions.)

Every claimed batch of messages gets a fencing token (`owner_token`) and a lease (`locked_until`,
the same column this service always had, now fencing-checked on write too). A worker renews the
lease every `HEARTBEAT_MS` while a send is in flight (`LOCK_TTL_MS`, default 120s; `HEARTBEAT_MS`,
default 10s — must be well under `LOCK_TTL_MS`), so a send taking longer than `LOCK_TTL_MS` never
loses its lock on its own. If a worker crashes or hangs long enough that its lock genuinely
expires, another worker (or the same one, restarted) reclaims the message as a failed attempt —
following the normal backoff/exhaustion schedule, which now costs an attempt (before Stage 6, a
reclaimed lock was reset for free, with no attempt cost) — and the fencing token means the original
worker cannot overwrite that outcome if it later finishes the send it no longer owns.

This makes **multiple worker processes against the same `DB_PATH` a supported topology**: the
commented-out split `notify-worker` app in `ecosystem.config.cjs` can run with `instances` > 1.
Claiming is atomic across processes (one `UPDATE ... RETURNING` statement), proven with real
cross-connection concurrency in `test/lease-concurrency.test.js`. Still one host, one SQLite file —
not a distributed queue; horizontal scaling across hosts still means moving to a server database.
See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## Observability

`notify` accepts and logs whatever `X-Request-Id` a caller sends (generating one when absent) but
does not yet parse, generate or forward `traceparent` — that is implemented in `gateway` and
`console`, per the platform's [OBSERVABILITY.md](../stack/docs/OBSERVABILITY.md). Outbound SMTP sends and webhook
POSTs carry `X-Notify-Id` but no request-id or trace header. See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

## Backup / restore

The only state to protect is the SQLite file at `DB_PATH` (WAL mode, so its `-wal`/`-shm`
companions matter too). Use `stack backup`/`stack restore` from the workspace root (see
`stack/docs/UPGRADE.md`) to snapshot and restore this consistently alongside the rest of the stack.
On every start, before applying a pending migration to an existing database, the service itself
also snapshots the file to `DB_PATH.pre-v<N>-<timestamp>` (directory overridable with
`DB_BACKUP_DIR`) — a manual last resort if `stack restore` is unavailable.

**Rollback limitations:** none of the migrations are reversible; to roll back, restore the
pre-migration copy (or a `stack backup` snapshot taken before the upgrade) and run the previous
version of this service against it. See [docs/READINESS.md](docs/READINESS.md) for the full
contract.

## License

MIT, see [LICENSE](LICENSE).
