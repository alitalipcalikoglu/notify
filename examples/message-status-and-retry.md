# Track, list and retry messages

## One message

```bash
curl -s $NOTIFY/v1/messages/<id> -H "Authorization: Bearer $KEY"
```

`404 NOT_FOUND` if the id does not exist or belongs to another API key. Template `data` is never returned (it may contain personal information).

Fields that change over time:

| Field | Meaning |
|---|---|
| `status` | `queued` → `processing` → `sent` or `failed` |
| `attempts` | Failed attempts so far |
| `nextAttemptAt` | When the worker will try again (only while `queued`) |
| `lastError` | Last failure message, e.g. `webhook responded 503: try later` |
| `providerId` | SMTP Message-ID or `http 200` for webhooks |
| `sentAt` | Delivery time |

## List

Newest first, cursor paging, optional status filter.

```bash
curl -s "$NOTIFY/v1/messages?status=failed&limit=50" -H "Authorization: Bearer $KEY"
```

```json
{ "items": [ { "id": "…", "status": "failed", "lastError": "webhook responded 400: bad payload", "...": "…" } ],
  "nextCursor": "MTc1ODAwMDAwMDAwMDo…" }
```

Next page:

```bash
curl -s "$NOTIFY/v1/messages?status=failed&limit=50&cursor=MTc1ODAwMDAwMDAwMDo…" -H "Authorization: Bearer $KEY"
```

`nextCursor` is `null` on the last page. A malformed cursor returns `400 INVALID_CURSOR`. `limit` is 1..100, default 20.

## Retry a failed message

After fixing the cause (partner endpoint back up, DNS corrected):

```bash
curl -s -X POST $NOTIFY/v1/messages/<id>/retry -H "Authorization: Bearer $KEY"
```

`200` with the message back in `queued`, `attempts` reset to 0. Only `failed` messages can be retried: anything else answers `409 NOT_RETRYABLE` with the current status in the message.

## Watching the queue drain

```bash
watch -n1 'curl -s $NOTIFY/metrics -H "Authorization: Bearer $KEY" | grep -E "notify_(messages|oldest)"'
```

`notify_oldest_queued_age_seconds` growing means deliveries are stuck; check `lastError` on the oldest queued items.
