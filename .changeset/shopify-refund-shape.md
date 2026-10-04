---
"@porulle/plugin-channel-connector": patch
---

Read Shopify's refund webhook as Shopify sends it: the refunded lines are `refund_line_items`, each naming its order line (and that line's variant) under `line_item`. Every real Shopify refund used to map no line and wait for an operator with an amount of 0. `refunds/create` is also registered for providers that subscribe per store.
