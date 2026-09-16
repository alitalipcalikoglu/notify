# Idempotent sends

Scenario: your backend retries failed HTTP calls. Without protection a retry sends the same email twice.

## Send with a key

```bash
curl -s -X POST $NOTIFY/v1/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "channel": "email", "template": "generic", "to": ["ali@example.com"],
        "idempotencyKey": "order-42-receipt",
        "data": { "appName": "Shop", "subject": "Receipt #42", "title": "Thanks for your order", "paragraphs": ["Order 42 is confirmed."] } }'
```

First call: `202`, `status: queued`.

## Retry the exact same call

Second call with the same `idempotencyKey`: `200 OK` and the **original** message (same `id`, current status). Nothing new is queued.

## Rules

- The key is unique per API key: `shop` and `blog` can both use `order-42-receipt` without colliding.
- 1 to 128 printable ASCII characters. Use something derived from your own record: `order-42-receipt`, `user-17-verify-3`.
- The payload of a replay is ignored; only the key matters. Do not reuse a key for a different message.
- Keys live as long as the message row. Sent and failed rows are purged after `RETENTION_DAYS` (default 30); after that the key can be used again.

## Telling a replay from a first send

| Response | Meaning |
|---|---|
| `202 Accepted` | New message queued |
| `200 OK` | Replay; body is the existing message |
