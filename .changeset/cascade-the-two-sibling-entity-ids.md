---
"@porulle/plugin-channel-connector": minor
---

`channel_catalog_conflicts.entity_id` and `channel_catalog_pushes.entity_id` cascade on delete.

Both name a `sellable_entities.id` and neither was tied to it, so deleting an entity left rows
behind — and each sits under a unique index that the dangling row then holds against that entity
being recreated: `channel_catalog_conflicts_open_unique` on `(store_id, entity_id, field_path)
WHERE state = 'open'`, and `channel_catalog_pushes_store_entity_unique` on `(store_id, entity_id)`.
That is the same defect that made an interrupted import unrecoverable through `channel_entity_map`,
fixed in 0.28.0, sitting in two tables nobody had yet deleted an entity out of.

Consumers that manage their own migrations need the two `ALTER TABLE ... ADD CONSTRAINT ... ON
DELETE cascade` statements; the constraint names follow drizzle's convention,
`channel_catalog_conflicts_entity_id_sellable_entities_id_fk` and
`channel_catalog_pushes_entity_id_sellable_entities_id_fk`.
