---
"@porulle/core": minor
---

Fire `catalog.afterUpdate` when a custom-field proposal is approved.

`CatalogService.reviewCustomField` wrote the approved row straight through the repository and ran no hooks, while `create`, `update` and `setAttributes` each resolve and run theirs. Approving a proposal therefore notified nothing: an approval REPLACES the live value, so anything downstream holding a derived copy of an entity's custom fields — a search projection, a feed, a cache — went on serving the value the approval had just displaced, with no event to tell it otherwise.

`EntityService.notifyEntityUpdated(entityId, changedFieldPaths, actor, ctx)` is new and public. It fires `catalog.afterUpdate` for an entity whose related rows changed while the entity row did not, passing the same before/after pair `setAttributes` already passes for the same reason: every consumer of this hook keys on the entity, not on the row that moved. `changedFieldPaths` carries `customFields.<locale>.<fieldName>` so a handler can narrow.

A rejection fires nothing. The live row is untouched and there is nothing for a consumer to re-read.
