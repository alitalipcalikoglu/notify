# Operations

## Probes

```bash
curl -s $NOTIFY/health   # {"status":"ok"} while the process runs
curl -s $NOTIFY/ready    # {"status":"ok"} when SQLite answers and the SMTP transport verifies; 503 otherwise
```

Readiness is cached for 30 s so probes do not open an SMTP connection each time. `503` body: `{"status":"unavailable","error":"…"}`.

## Metrics

```bash
curl -s $NOTIFY/metrics -H "Authorization: Bearer $KEY"
```

```
notify_messages{status="queued"} 3
notify_messages{status="processing"} 1
notify_messages{status="sent"} 1204
notify_messages{status="failed"} 2
notify_oldest_queued_age_seconds 0.412
notify_process_uptime_seconds 86400
```

Alert on `notify_oldest_queued_age_seconds` above a few minutes and on `failed` growing.

## Environment

Required: `NOTIFY_API_KEYS`, `SMTP_URL`, `SMTP_FROM`, `WEBHOOK_SIGNING_SECRET`. Generate secrets with `openssl rand -hex 32`. Full list with defaults: [.env.example](../.env.example).

Give every calling service its own key so one can be rotated without touching the others:

```
NOTIFY_API_KEYS=auth:6f1c…,shop:a09e…,gateway:77d2…
```

## Process manager

```bash
pm2 start ecosystem.config.cjs   # reads ./.env
pm2 reload notify                # restart after a deploy: waits for the app's ready signal
pm2 logs notify --json
```

Logs are JSON lines (pino). `req.headers.authorization` is redacted. Recipient addresses appear in `message queued` lines; treat logs as personal data.

## Docker

```bash
docker build -t atc-notify .
docker run -d -p 3001:3001 -v notify-data:/data --env-file .env atc-notify
```

The SQLite file lives in `/data`; keep the volume.

## TLS between servers

Either terminate TLS in a reverse proxy and set `TRUST_PROXY=true`, or set `TLS_CERT_PATH`/`TLS_KEY_PATH` to serve HTTPS directly.

## Backups

Stop-free backup of the queue database:

```bash
sqlite3 data/notify.db ".backup 'notify-$(date +%F).db'"
```
