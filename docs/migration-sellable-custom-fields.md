# Sellable custom-field provenance migration

Core consumers own their Drizzle migrations. The migration adds provenance,
review, locale, and timestamp columns with defaults that apply to existing
rows, de-duplicates any legacy rows, then replaces the old full unique index
with the approved-value index:

```sql
ALTER TABLE "sellable_custom_fields" ADD COLUMN "source" text DEFAULT 'merchant' NOT NULL;--> statement-breakpoint
ALTER TABLE "sellable_custom_fields" ADD COLUMN "status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "sellable_custom_fields" ADD COLUMN "confidence" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "sellable_custom_fields" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "sellable_custom_fields" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "sellable_custom_fields" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sellable_custom_fields" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "sellable_custom_fields" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sellable_custom_fields" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DELETE FROM "sellable_custom_fields" AS older
USING "sellable_custom_fields" AS newer
WHERE older."entity_id" = newer."entity_id"
  AND older."field_name" = newer."field_name"
  AND older.ctid < newer.ctid;--> statement-breakpoint
DROP INDEX IF EXISTS "sellable_custom_fields_entity_field_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "sellable_custom_fields_live_unique"
  ON "sellable_custom_fields" USING btree ("entity_id", "field_name", "locale")
  WHERE "status" = 'approved';
```

The de-duplication keeps the most recently inserted row per
`(entity_id, field_name)`. Legacy writes were insert-only and the table had no
creation timestamp, so the highest physical tuple location identifies the
newest row; the DELETE is a no-op on tables that already ran the earlier full
`(entity_id, field_name)` uniqueness migration. All added columns carry
defaults, so existing rows become merchant-owned, approved, English-locale
values with timestamps and need no further backfill.
