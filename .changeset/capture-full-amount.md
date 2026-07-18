---
"@porulle/core": patch
---

Fix payment capture recording `amountCaptured: 0` on a full capture. Both the
manual capture (`POST /api/orders/{id}/capture` with no amount) and the checkout
auto-capture step called the payment adapter without an amount and then trusted
the value it echoed back. Adapters that return `0` for an omitted amount (the dev
Stripe mock, and any custom adapter that doesn't default to the authorized total
the way Stripe does) caused the order to record a `$0` capture — which then capped
refunds at `$0`. The order module now passes the amount it intends to capture
(the requested partial amount, else the order's `grandTotal` / checkout total) and
records that when the adapter does not report a positive figure.
