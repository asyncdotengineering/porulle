---
"@porulle/core": minor
---

Price, stock and hydrate many products in a constant number of queries.

- `PricingService.resolveMany({ items, currency, quantity, customerGroupIds?, timestamp?, entities? }, actor, ctx?)` prices every (entity, variant) pair with one prices read and one modifiers read, plus one entity read (none when `entities` is passed). Currency, quantity window, validity window and customer group are filtered in SQL. Each pair carries its own `Result`, so one unpriced item never fails the batch. `resolve` is now a one-item call to it; the pricing rules are unchanged.
- `InventoryService.getAvailableMany(items, actor?, ctx?)` returns available quantity for many (entity, variant) pairs in one query, keyed `${entityId}:${variantId ?? ""}`. `getAvailable` is now a one-item call to it.
- `CatalogService.getManyForInternalUse(ids, organizationId, options?, ctx?)` hydrates many entities with one read per included relation: variants come with their option value ids and option types with their values in a single join each. `getByIdForInternalUse` is now a one-item call to it.
- New indexes on `variants(entity_id)`, `option_types(entity_id)` and `option_values(option_type_id)`. Generate and apply a migration in your app.
