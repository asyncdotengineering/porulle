---
"@porulle/adapter-shopify": minor
---

Add an optional `paymentGateway` option to `shopifyConnector` so hosts can set the payment gateway name recorded on `orderCreate` transactions (defaulting to `"porulle"`), without changing `sourceName` or `sourceIdentifier`.
