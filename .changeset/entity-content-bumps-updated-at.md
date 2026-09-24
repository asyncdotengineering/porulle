---
"@porulle/core": minor
---

Editing an entity's content moves `sellable_entities.updated_at`, so consumers that version a product from it see the edit.

- `catalog.setAttributes` (title, subtitle, description, SEO fields) used to write `sellable_attributes` and fire `catalog.afterUpdate` with the entity row unchanged. A changed title was therefore invisible to anything versioning on `updated_at`, such as a search projection. The attribute write and the entity's `updated_at` bump now commit together, in the caller's transaction when there is one, and `catalog.afterUpdate` receives the bumped row.
- Re-setting identical values writes nothing, moves nothing and fires no hook.
- Approving a custom field bumps `updated_at` the same way.
- Not versioned by this release: category and brand links, media attachment, option types and values, tag links. Variants carry their own `variants.updated_at`.
