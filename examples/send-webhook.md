# Send a webhook

**Legacy, one-off calls only.** This channel is a simple signed POST with no subscription model,
secret rotation, replay or delivery history — for durable/retry-oriented delivery to external
partners (subscriptions, replay, rotation), use `webhook-out` instead. It can also be turned off
entirely with `NOTIFY_WEBHOOK_CHANNEL=false`, in which case this request is rejected with `403
WEBHOOK_CHANNEL_DISABLED` (email is unaffected).

Scenario: an order was paid; a partner's system must be notified with a signed JSON payload.

## 1. Queue the webhook

```bash
curl -s -X POST $NOTIFY/v1/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "channel": "webhook",
    "url": "https://api.partner.example/hooks/orders",
    "event": "order.paid",
    "data": { "orderId": 42, "total": 199.9, "currency": "TRY" },
    "headers": { "X-Tenant": "shop-1" }
  }'
```

`202` with the same message shape as email (`url` and `event` filled, `template` null).

## 2. What the partner receives

```
POST /hooks/orders HTTP/1.1
Host: api.partner.example
Content-Type: application/json
User-Agent: atc-notify/1.0
X-Notify-Id: 8d0a…            ← message id
X-Notify-Event: order.paid
X-Notify-Signature: t=1758000000,v1=9f2c…   ← HMAC-SHA256
X-Tenant: shop-1
```

```json
{ "id": "8d0a…", "event": "order.paid", "timestamp": "2026-09-16T04:10:00.000Z", "data": { "orderId": 42, "total": 199.9, "currency": "TRY" } }
```

The receiver must answer `2xx`. Redirects are not followed and count as failure.

## 3. Verifying the signature (receiver side)

`v1 = HMAC-SHA256(WEBHOOK_SIGNING_SECRET, "<t>.<raw body>")`. Reject timestamps older than a few minutes.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, rawBody, header, toleranceSec = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest();
  const given = Buffer.from(m[2], 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

Use the raw request body bytes, not a re-serialised object. Share `WEBHOOK_SIGNING_SECRET` with the partner out of band.

## Custom headers

Only `X-*` names and `Authorization` are accepted, at most 10, printable ASCII values up to 1024 chars. `X-Notify-*` names are overwritten by the service.

```json
{ "headers": { "Authorization": "Bearer partner-token", "X-Trace": "abc" } }
```

## Targets that are refused

The URL is resolved before connecting. These fail permanently (`status: failed`, no retry):

- `http://` unless `WEBHOOK_ALLOW_HTTP=true`
- credentials in the URL (`https://user:pass@…`)
- hosts resolving to loopback, private, link-local, multicast or other special ranges (IPv4 and IPv6, including mapped and NAT64 forms)
- hosts outside `WEBHOOK_ALLOWED_HOSTS` when that list is set

`lastError` explains which rule matched, e.g. `host "internal.example" resolves to non-public address 10.0.0.5`.
