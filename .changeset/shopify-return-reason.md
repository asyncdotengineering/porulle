---
"@porulle/adapter-shopify": patch
---

Shopify returns carry a reason. Live Shopify (2026-10) refuses a `returnRequest` line with no reason ("Return reason can't be blank") although the schema marks it optional. `requestReturn` now resolves the shopper's reason to Shopify's reason library by handle ("Too small" → `too-small`), falling back to `other-reason`, and sends it as `returnReasonDefinitionId` on every line.
