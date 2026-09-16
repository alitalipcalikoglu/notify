# Retries, failures and backoff

## Lifecycle

```
queued ──claim──▶ processing ──ok──▶ sent
                      │
                      └──error──▶ queued (next attempt later)   or   failed (permanent / attempts exhausted)
```

## Transient vs. permanent

| Channel | Retried | Failed immediately |
|---|---|---|
| email | network errors, SMTP 4xx, 552 | SMTP 5xx (bad mailbox, policy rejection) |
| webhook | connection errors, timeout, 408, 425, 429, 5xx | any other 3xx/4xx, blocked target (private address, scheme, allowlist), DNS name with no addresses |

`lastError` keeps the reason, e.g. `webhook responded 400: bad payload` or `550 5.1.1 no such user`.

## Backoff

Delay before attempt *n* is between half and full of `min(BACKOFF_BASE_MS × 2^(n-1), BACKOFF_CAP_MS)`.

With defaults (`BACKOFF_BASE_MS=5000`, `BACKOFF_CAP_MS=3600000`, `MAX_ATTEMPTS=8`):

| Attempt | Delay window |
|---|---|
| 1 | 2.5 s – 5 s |
| 2 | 5 s – 10 s |
| 3 | 10 s – 20 s |
| 4 | 20 s – 40 s |
| 5 | 40 s – 80 s |
| 6 | 80 s – 160 s |
| 7 | 160 s – 320 s |
| 8 | 320 s – 640 s → then `failed` |

A partner outage of about 20 minutes is absorbed; longer needs a manual `retry`.

## Crash in the middle of a send

A message stays `processing` with `locked_until` set. If the process dies, the next start (and every minute afterwards) returns rows whose lock expired (`LOCK_TTL_MS`, default 120 s) to `queued`. The worst case is one duplicate delivery of that message; make webhook receivers idempotent on `X-Notify-Id`.

## Tuning

| Setting | Effect |
|---|---|
| `WORKER_CONCURRENCY` | Parallel deliveries per pass (default 5). Raise for high volume, mind SMTP provider limits. |
| `WORKER_POLL_MS` | Idle poll interval (default 500 ms). |
| `WEBHOOK_TIMEOUT_MS` | Per webhook request (default 10 s). Must be well below `LOCK_TTL_MS`. |
| `RETENTION_DAYS` | Sent/failed rows are deleted after this (default 30). |
