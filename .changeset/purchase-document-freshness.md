---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

Every write that changes a product's prices, variants, options or SKU now announces itself in the writer's transaction.

- Pricing hooks run in the writer's transaction for a hook marked `inTransaction`. `setBasePrice`, `createModifier` and `updateModifier` used to run every hook after commit with `tx: null`, so a derived copy of a price could be read stale after the new row was stored.
- `pricing.afterDelete` (new) runs after `deleteModifier` with the deleted modifier, in the caller's transaction for a hook marked `inTransaction`. It is audited (`price` / `deleted`) and delivered to webhooks subscribed to `pricing.delete`. A deleted modifier announced nothing before.
- `catalog.afterUpdate` now fires (once per call, in the caller's transaction) from `createOptionType`, `createOptionValue`, `createVariant`, `generateVariants`, `quickCreateVariant` and `bulkCreateVariants` when they write, and from `restoreEntityRevision`, which rewrites the slug and metadata.
- The channel connector calls `notifyEntityChanged` after it relabels or reorders option types and values, rewrites a variant's option values (inside that write's transaction) and applies an upstream SKU or barcode (inside that write's transaction).
