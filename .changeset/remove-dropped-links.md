---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

A converge now removes the tag, category and brand links the store dropped, and versions the entity when it does.

- New table `channel_entity_links` (connector schema) records link provenance: the category, brand and tag links each store's converge created on an entity. **Consumers must create it before upgrading** (DDL in the PR).
- On a converge of an existing product, links on record for this store that the item no longer lists are deleted, along with their provenance. Adds and removes share one transaction and ONE `catalog.afterUpdate` carrying the union of paths.
- A link the merchant added is never removed: it has no provenance for the store. The same holds for a link that existed before the store listed it.
- Products imported before this release claim, on their first converge, the links the store lists at that moment. A link the store had already dropped by then was never on record and stays.
- New in core: `removeEntityLinks(db, orgId, rows)`, the sibling of `writeEntityLinks`. It is org-scoped in the statement and returns the deleted rows, which `linkFieldPaths` names.
