# Audit events

Set both variables to forward events to the audit service (repository `audit`); leave both empty to keep the service silent:

```
AUDIT_URL=http://10.0.0.5:3005
AUDIT_API_KEY=<the notify key from AUDIT_API_KEYS, role write>
```

The key id becomes the event `source` on the audit side. Events are buffered in memory (up to 5 000), flushed every 2 seconds in batches of 200, retried with backoff and idempotent ids, and dropped with a log line when the audit service rejects them. A request is never slowed down or failed by auditing.

## Actions

One event per completed write request, `outcome: "success"` for 2xx, `outcome: "denied"` when the key's role refused it (403). Failed validations and other errors are not audit events.

| Action | Request |
|---|---|
| `notify.message.create` | `POST /v1/messages` |
| `notify.message.retry` | `POST /v1/messages/:id/retry` |

## Event shape

```json
{
  "id": "0f1a…",
  "at": "2026-09-17T10:00:00.000Z",
  "action": "notify.message.create",
  "outcome": "success",
  "actor": { "type": "apikey", "id": "console" },
  "target": { "type": "…", "id": "…" },
  "ip": "203.0.113.7",
  "userAgent": "…",
  "requestId": "…",
  "meta": { "…": "…" }
}
```

`meta` carries the request patch or a summary (counts) where useful; secrets never appear in it. Query the audit service by `source=notify`, `actionPrefix=notify.` or by target to reconstruct what happened to an entity.
