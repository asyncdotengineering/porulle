# Sellable custom-field uniqueness migration

Core consumers own their Drizzle migrations. Before applying the generated
unique index for `sellable_custom_fields`, remove older duplicate rows so the
index can be created:

```sql
DELETE FROM "sellable_custom_fields" AS older
USING "sellable_custom_fields" AS newer
WHERE older."entity_id" = newer."entity_id"
  AND older."field_name" = newer."field_name"
  AND older.ctid < newer.ctid;
--> statement-breakpoint
CREATE UNIQUE INDEX "sellable_custom_fields_entity_field_unique"
  ON "sellable_custom_fields" ("entity_id", "field_name");
```

The table has no creation timestamp, and legacy writes were insert-only, so the
highest physical tuple location identifies the most recently inserted row.
