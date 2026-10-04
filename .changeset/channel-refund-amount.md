---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
"@porulle/adapter-woocommerce": patch
---

A store refund for part of a line pays back exactly that part. `refund.created` carries the store's refunded `amount` when the store says it; the connector records the lesser of that and the platform's own price for the lines, keeps the refunded lines on the request (`channel_refund_requests.lines`), auto-approves only a whole-line refund, and `orders.refundLines` takes an `amount` to pay back less than the lines' value. WooCommerce reports its refund amount.
