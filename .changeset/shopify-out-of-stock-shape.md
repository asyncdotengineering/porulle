---
"@porulle/adapter-shopify": patch
---

Read live Shopify's stock refusal as out of stock. Shopify (2026-10, measured) refuses an `orderCreate` it cannot reserve stock for with `code: INVALID`, `field: ["order","lineItems"]`, "Line items Unable to reserve inventory" — not the documented `INVENTORY_CLAIM_FAILED`. The adapter now answers `CHANNEL_OUT_OF_STOCK` for either, so the marketplace cancels the order and refunds the shopper instead of leaving a paid order whose export failed.
