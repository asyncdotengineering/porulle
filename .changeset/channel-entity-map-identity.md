---
"@porulle/plugin-channel-connector": minor
---

Tie `channel_entity_map`'s identity to the entity it names.

`channel_entity_map` was the importer's only record of identity and nothing connected it to the
`sellable_entities` row it pointed at, which made an interrupted catalog import unrecoverable:

- `entity_id` now carries a foreign key to `sellable_entities` with `ON DELETE CASCADE`. Deleting an
  entity previously left its `kind='variant'` map rows dangling, and because those rows hold the
  unique `(store_id, kind, external_id)` slot, the product could never be imported again — so the
  obvious operator repair made the situation permanently worse.
- A new entity and its `kind='entity'` map row are now written in one transaction, through
  `catalog.create`'s transaction context. The map row is inserted with a sentinel `sync_hash` that
  no real hash can equal, so an import interrupted mid-item re-converges on the next run instead of
  being skipped as unchanged.
- The identity check reads the map row and the entity together and resolves divergence in both
  directions: a mapping whose entity is gone is cleared rather than skipped for ever, and an entity
  on this store with the item's slug and no mapping is adopted rather than colliding. Previously
  that collision returned an error from `convergeCatalogItems`, aborting the entire import run
  rather than one item.
