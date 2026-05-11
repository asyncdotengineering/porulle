# @porulle/adapter-resend

Transactional email via [Resend](https://resend.com). Implements the `email.send` callback in `CommerceConfig`.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { resendEmailAdapter } from "@porulle/adapter-resend";

export default defineConfig({
  email: {
    send: resendEmailAdapter({
      apiKey: process.env.RESEND_API_KEY!,
      from: "Acme Store <orders@acme.com>",
      // Optional: per-template subject + HTML overrides
      subjects: {
        "order-confirmation": (d) => `Your order ${d.orderNumber} is confirmed`,
      },
      templates: {
        "order-confirmation": (d) => `<p>Thanks for ordering ${d.itemCount} items.</p>`,
      },
      // Optional: use Resend's server-side templates instead of local HTML
      resendTemplateIds: {
        "order-confirmation": "tmpl_abc123",
      },
    }),
  },
  // …
});
```

## What gets sent

The kernel emits emails via the `email.send` callback for:

- `email-verification` — Better Auth signup
- `password-reset` — Better Auth password reset
- `order-confirmation` — `orders.afterCreate`
- (plugins can add their own — see plugin docs)

Templates not in `subjects` / `templates` get a minimal fallback so nothing silently fails to render.

## See also

- [Resend docs](https://resend.com/docs)
- `@porulle/adapter-ses` — AWS SES alternative
