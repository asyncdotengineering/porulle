---
"@porulle/core": minor
---

A caller can store what a product's price is chosen from and price it later, and learns every write that changes available stock.

- `inventory.afterAvailabilityChange` runs after `reserve`, `release` and `deductForFulfillment`, in the caller's transaction for a hook marked `inTransaction`, with `{ organizationId, entityId, variantId, operation }`. Those writes change available quantity and announced nothing.
- `resolvePriceAt` (exported) prices one pair from candidate rows: it keeps the rows in their quantity bounds, valid at the moment and for the customer groups, then applies the selection rules. `resolveMany` prices through it.
- `pricing.priceCandidates` reads every price and modifier that can ever apply to some products in a currency, windows and bounds unfiltered. `ResolvableModifier` now carries its customer group, quantity bounds and validity window.
- The batched variant read (`includeVariants`) returns each variant once with its option value ids aggregated in SQL, instead of one row per option value.
