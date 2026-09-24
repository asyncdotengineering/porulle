---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

A change to an entity's links (category, brand, tag, media) moves `sellable_entities.updated_at` and fires `catalog.afterUpdate`, so a re-categorised or re-branded product re-indexes.

- `addToCategory` / `removeFromCategory` / `addToBrand` / `removeFromBrand` version the entity only when a link actually changed. Re-adding an existing link moves nothing. `catalog.afterUpdate` receives the bumped row with `changedFieldPaths` of `categories` or `brand`.
- `media.attachToEntity` versions the entity with `media.<role>`, since the hero drives the image embedding.
- New: `catalog.notifyEntityChanged(entityId, changedFieldPaths, actor, ctx)`, which moves `updated_at` and fires `catalog.afterUpdate` for a change to related rows. The channel connector uses it when a converge adds a tag link.
- An unchanged converge still reports `converged: 0` and moves no entity's `updated_at`.
- Option types and values are not versioned here; variants carry `variants.updated_at`.
