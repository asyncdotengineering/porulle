# @porulle/adapter-stripe

`PaymentAdapter` for [Stripe](https://stripe.com). The reference implementation of the payment-adapter contract.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { stripePayment } from "@porulle/adapter-stripe";

export default defineConfig({
  payments: [
    stripePayment({
      secretKey: process.env.STRIPE_SECRET_KEY!,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      apiVersion: "2025-08-27.basil",  // optional override
    }),
  ],
  // …
});
```

## What it implements

| Adapter method | Stripe call |
|---|---|
| `createPaymentIntent({ amount, currency })` | `stripe.paymentIntents.create()` |
| `capturePayment(intentId, amount?)` | `stripe.paymentIntents.capture()` — returns `amountCaptured` (the framework reads this and stores it on the order; refunds are then capped at this value) |
| `refundPayment(paymentId, amount, reason?)` | `stripe.refunds.create()` |
| `cancelPaymentIntent(intentId)` | `stripe.paymentIntents.cancel()` |
| `verifyWebhook(payload, signature)` | `stripe.webhooks.constructEvent()` (timing-safe HMAC compare under the hood) |

## Why this is the reference

It's the canonical example of the [Payment Adapter Contract](https://github.com/asyncdotengineering/porulle/blob/main/apps/docs/src/content/docs/extending/payment-adapter-contract.mdx):

- Returns accurate `amountCaptured` (so refund cap works)
- Idempotency keys propagate through Stripe's `Idempotency-Key` header
- Webhook signature verification is timing-safe (Stripe SDK handles)
- Errors return `Result<T>` — never throws across module boundaries
- Vendor SDK (`stripe`) is isolated to this package; never leaks into core

If you build a new payment adapter, mirror this file's shape.

## See also

- [Payment Adapter Contract](https://github.com/asyncdotengineering/porulle/blob/main/apps/docs/src/content/docs/extending/payment-adapter-contract.mdx) — the contract this implements
- [Stripe API reference](https://stripe.com/docs/api)
