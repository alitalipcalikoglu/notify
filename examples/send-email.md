# Send an email

Scenario: a shop backend sends a verification email right after sign-up.

## 1. Queue the message

```bash
curl -s -X POST $NOTIFY/v1/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "channel": "email",
    "template": "email-verification",
    "to": ["ali@example.com"],
    "data": {
      "appName": "Shop",
      "verifyUrl": "https://shop.example.com/verify?token=3f9a…",
      "expiresInMinutes": 30,
      "name": "Ali",
      "locale": "tr"
    }
  }'
```

Response `202 Accepted`, header `Location: /v1/messages/<id>`:

```json
{
  "id": "70f22fb3-792d-4616-9d9f-7693f4db2dbc",
  "channel": "email",
  "status": "queued",
  "template": "email-verification",
  "event": null,
  "to": ["ali@example.com"],
  "url": null,
  "attempts": 0,
  "maxAttempts": 8,
  "nextAttemptAt": "2026-09-16T04:08:28.791Z",
  "lastError": null,
  "providerId": null,
  "createdAt": "2026-09-16T04:08:28.791Z",
  "updatedAt": "2026-09-16T04:08:28.791Z",
  "sentAt": null
}
```

Nothing has been sent yet. The request returns in milliseconds; the worker delivers in the background.

## 2. Check delivery

```bash
curl -s $NOTIFY/v1/messages/70f22fb3-792d-4616-9d9f-7693f4db2dbc -H "Authorization: Bearer $KEY"
```

```json
{ "status": "sent", "providerId": "<16ec280a-…@shop.example.com>", "sentAt": "2026-09-16T04:08:28.838Z", "attempts": 0, "...": "…" }
```

`providerId` is the SMTP `Message-ID`; search for it in your mail provider's logs.

## Optional fields

```json
{ "cc": ["manager@example.com"], "bcc": ["archive@example.com"], "replyTo": "support@example.com" }
```

Up to 10 addresses each, no duplicates. Every address is validated as an email.

## What the recipient sees

Subject and body come from the template (`tr` or `en`), the `From` header from `SMTP_FROM`. Every value in `data` is HTML-escaped; `verifyUrl` must be `http(s)`, anything else is dropped from the button. The message carries an `X-Notify-Id` header with the message id.

## Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Envelope problem (bad email, unknown template, extra field). `details[].path` points at the field. |
| 400 | `VALIDATION_FAILED` | `data` does not match the template schema. Paths start with `/data`. |
| 401 | `UNAUTHORIZED` | Missing or wrong API key. |
| 413 | | Body over `BODY_LIMIT` (default 64 KB). |
| 429 | `RATE_LIMITED` | More than `RATE_LIMIT_MAX` requests per minute for this key. `Retry-After` is set. |

Example of a data error:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "data does not match template \"email-verification\"",
  "details": [ { "path": "/data/verifyUrl", "message": "must match pattern \"^https?://\"", "params": { "pattern": "^https?://" } } ] } }
```

## Local development

Set `SMTP_URL=json:`. Messages are marked `sent` and written to the log as JSON instead of leaving the machine.
