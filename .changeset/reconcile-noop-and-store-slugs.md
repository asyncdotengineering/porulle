---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

Stop a reconcile over an unchanged catalogue from rewriting it, and let two stores in one organization sell the same handle.

- `inventory.setAbsolute` to the quantity already on hand is a no-op: no movement row and no `inventory.afterAdjust` (the permission is still checked). One sim reconcile had re-announced 1,243 unchanged levels.
- `channel/reconcile` counts `converged` from what it actually wrote, not from a changed sync hash, so `driftAlert` no longer fires on an unchanged catalogue. Reconcile and inventory sync compare negative remote stock as the zero it is stored as, so oversold variants are not re-levelled on every run.
- Product slugs stay unique per organization (the storefront resolves `/:idOrSlug` org-wide). A handle another store already holds becomes `<handle>-<store domain label>`, falling back to `<handle>-<label>-<store id prefix>`. Once a slug is assigned it is kept on every later converge, so shared links don't break.
- A duplicate SKU inside one store now fails only that item, with its error, instead of failing the page and causing a retry.
- New: `channelCatalogItemSchema`, `channelCatalogVariantSchema`, `channelInventoryLevelSchema` (and the nested schemas) exported from `@porulle/core`. A compile-time check keeps them equal to the `ChannelCatalogItem` interfaces. Parse catalog items at a trust boundary (queue, R2, fixtures) with these rather than re-declaring a subset.
