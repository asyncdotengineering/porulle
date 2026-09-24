---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

A change to an entity's links (category, brand, tag, media) moves `sellable_entities.updated_at` and fires `catalog.afterUpdate`, so a re-categorised or re-branded product re-indexes.

- `addToCategory` / `removeFromCategory` / `addToBrand` / `removeFromBrand` version the entity only when a link actually changed. Re-adding an existing link moves nothing. `catalog.afterUpdate` receives the bumped row with `changedFieldPaths` of `categories` or `brand`.
- `media.attachToEntity` versions the entity with `media.<role>`, since the hero drives the image embedding.
- New: `catalog.notifyEntityChanged(entityId, changedFieldPaths, actor, ctx)`, which moves `updated_at` and fires `catalog.afterUpdate` for a change to related rows.
- New: `writeEntityLinks(db, orgId, rows)` and `linkFieldPaths(written)`, the one link writer for the bulk paths. `importProducts` and the channel converge (editor and fast path) both write through it. Org scope is enforced in the statement: a row that names another organization's entity, category, brand, tag or media asset writes nothing. It returns only the links that actually changed.
- The channel converge writes each item's links, and its version bump, in ONE transaction. It fires ONE `catalog.afterUpdate` per item carrying every changed link path (for example `["categories","media.gallery","tags"]`). A role change names both roles. An entity created by that same converge is not versioned for its links. Measured on a cold import of 5 products: 5 `afterUpdate`s (their titles, as at 0.54.0) and 397 statements, against 732 at 0.54.0.
- An unchanged converge still reports `converged: 0` and moves no entity's `updated_at`.
- Option types and values are not versioned here; variants carry `variants.updated_at`.
