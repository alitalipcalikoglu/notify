# Templates and their schemas

Callers send data, never HTML. Each template declares a JSON Schema for `data`; the service validates before queueing and escapes every value when rendering.

## List templates

```bash
curl -s $NOTIFY/v1/templates -H "Authorization: Bearer $KEY"
```

```json
{ "items": [
  { "name": "email-verification", "description": "Account activation link sent after sign-up.",
    "schema": { "type": "object", "required": ["appName", "verifyUrl", "expiresInMinutes"],
                "properties": { "locale": { "enum": ["tr", "en"], "default": "tr" }, "appName": {}, "name": {}, "verifyUrl": {}, "expiresInMinutes": {} } } },
  { "name": "password-reset", "…": "…" },
  { "name": "generic", "…": "…" } ] }
```

Use the schemas to build request validation in your own backend.

## Built-in templates

| Template | Required data | Optional |
|---|---|---|
| `email-verification` | `appName`, `verifyUrl`, `expiresInMinutes` | `name`, `locale` |
| `password-reset` | `appName`, `resetUrl`, `expiresInMinutes` | `name`, `requestIp`, `locale` |
| `generic` | `appName`, `subject`, `title`, `paragraphs[]` | `button { label, url }`, `footnote`, `locale` |

`generic` covers most transactional mail:

```json
{ "channel": "email", "template": "generic", "to": ["ali@example.com"],
  "data": { "locale": "en", "appName": "Shop", "subject": "Your order shipped", "title": "On its way",
            "paragraphs": ["Order 42 left our warehouse today.", "Tracking: TR123456789"],
            "button": { "label": "Track package", "url": "https://shop.example.com/orders/42" },
            "footnote": "Questions? Reply to this email." } }
```

## Validation failure

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "data does not match template \"generic\"",
  "details": [ { "path": "/data/paragraphs", "message": "must NOT have fewer than 1 items", "params": { "limit": 1 } } ] } }
```

## Adding a template

Templates are code, deployed with the service.

1. Create `src/templates/order-shipped.js`:

```js
import { EmailTemplate } from './template.js';

export class OrderShippedTemplate extends EmailTemplate {
  get name() { return 'order-shipped'; }
  get description() { return 'Shipping confirmation with tracking link.'; }
  get schema() {
    const c = EmailTemplate.common;
    return { type: 'object', additionalProperties: false, required: ['appName', 'orderId', 'trackingUrl'],
      properties: { locale: c.locale, appName: c.appName, orderId: c.shortText, trackingUrl: c.httpsUrl } };
  }
  subject(d) { return d.locale === 'en' ? `Order ${d.orderId} shipped` : `${d.orderId} numaralı sipariş kargoda`; }
  layout(d) {
    return { locale: d.locale, appName: d.appName, title: this.subject(d),
      paragraphs: [d.locale === 'en' ? 'Your package is on its way.' : 'Paketiniz yola çıktı.'],
      button: { label: d.locale === 'en' ? 'Track' : 'Takip et', url: d.trackingUrl } };
  }
}
```

2. Register it in `TemplateRegistry.withDefaults()` (`src/templates/registry.js`).
3. Add a render test to `test/templates.test.js`, run `npm test`, deploy.

`layout()` returns plain strings; `Layout` escapes them on output, so template code never touches HTML.
