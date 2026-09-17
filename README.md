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

`kill_timeout` is 60 s so in-flight deliveries finish before PM2 escalates to SIGKILL. Keep `instances: 1`: the delivery worker runs in-process and one SQLite file expects one writer.

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

## API

Every `/v1` and `/metrics` request needs `Authorization: Bearer <secret>`. Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. No auth. |
| GET | `/ready` | Readiness: database and SMTP reachable (cached 30 s). No auth. |
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

- Delivery runs in-process. Up to `WORKER_CONCURRENCY` messages are claimed atomically per pass.
- Failures retry with exponential backoff and jitter (`BACKOFF_BASE_MS` doubling up to `BACKOFF_CAP_MS`) until `MAX_ATTEMPTS`.
- Permanent failures stop immediately: SMTP 5xx replies, webhook 3xx/4xx other than 408/425/429, and any blocked target.
- A message left in `processing` longer than `LOCK_TTL_MS` (crash mid-send) is returned to the queue.
- `sent` and `failed` rows are deleted after `RETENTION_DAYS`.
- `idempotencyKey` is unique per API key; a repeat returns the original message instead of sending twice.

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

- API secrets are compared in constant time; every configured key is checked so timing does not reveal which one matched.
- Rate limit per API key (`RATE_LIMIT_MAX` per minute).
- Webhook targets are resolved before connecting and rejected when any address is loopback, private, link-local, multicast, or another special range (IPv4 and IPv6 including mapped, NAT64, 6to4 and Teredo forms). The vetted address is pinned for the connection so DNS rebinding cannot redirect it. `https` only unless `WEBHOOK_ALLOW_HTTP=true`. URLs with credentials are rejected.
- Template data is escaped on output; button URLs must be `http(s)`; subjects are collapsed to one line to prevent header injection.
- Request bodies are capped at `BODY_LIMIT` bytes; unknown fields are rejected.
- Template `data` is never returned by the API (it may contain personal data). Logs redact `Authorization`.
- Container runs as the unprivileged `node` user.

## Out of scope by design

- SMS and push channels: these need a provider account; add a channel module next to `src/channels/` when one is chosen.
- Attachments: the service sends templated messages only. Send a link instead.
- Multiple worker processes on one SQLite file: claims are atomic, so it works, but the intended deployment is one instance per database. Move to Postgres if you need horizontal scaling.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## Scaling model

One process owns one SQLite file (`DB_PATH`); `ecosystem.config.cjs` hardcodes `instances: 1` for
that reason. Message claiming is a single atomic SQL statement, so a second instance against the
same file would not double-deliver, but nothing coordinates migrations or maintenance across
instances — it is not a supported scale-out path. Horizontal scaling means moving to a server
database. See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## Observability

`notify` accepts and logs whatever `X-Request-Id` a caller sends (generating one when absent) but
does not yet parse, generate or forward `traceparent` — that is implemented in `gateway` only, per
the platform's [OBSERVABILITY.md](../stack/docs/OBSERVABILITY.md). Outbound SMTP sends and webhook
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
