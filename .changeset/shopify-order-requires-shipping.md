---
"@porulle/adapter-shopify": patch
---

Mark every exported order line `requiresShipping: true`. Shopify's `orderCreate` defaults it to false, so a real store showed each pushed order as "Shipping not required" although it carried the shopper's address, and the merchant could not ship it the normal way. The workerd test now pushes an order and asserts what Shopify receives.
