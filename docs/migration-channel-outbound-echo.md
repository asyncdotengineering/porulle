# Channel outbound echo suppression migration

Core consumers own their Drizzle migrations. The migration adds the outbound
write-ahead state on `channel_entity_map` used to recognize the store's echo of
our own catalog push:

```sql
ALTER TABLE "channel_entity_map" ADD COLUMN "outbound_hash" text;--> statement-breakpoint
ALTER TABLE "channel_entity_map" ADD COLUMN "outbound_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_entity_map" ADD COLUMN "outbound_field_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;
```

No backfill is required. The columns are written ahead of each `pushCatalog`
call and confirmed or cleared per item outcome. A NULL `outbound_hash` means no
push is in flight for the mapping, so inbound processing behaves exactly as
before the migration.

An inbound item counts as an echo only when it arrives within the suppression
window (`CATALOG_OUTBOUND_SUPPRESSION_WINDOW_MS`, 15 minutes) and its canonical
hash over `outbound_field_paths` equals `outbound_hash`. An echo advances the
sync baseline without writing entity data and without raising shared-field
conflicts for the certified paths; shared paths outside `outbound_field_paths`
are still value-compared, so a genuine store edit riding in the echo payload
raises its conflict and hold. After a failed push the mapping's `sync_hash` is
set to the empty-string sentinel, which forces the next inbound item to
converge rather than being skipped as unchanged.
