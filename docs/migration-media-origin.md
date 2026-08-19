# Media origin and association migration

Core consumers own their Drizzle migrations. The migration adds provenance and
derivation metadata to media assets, timestamps entity-media associations,
de-duplicates any legacy association rows, and enforces one asset per entity
level and per variant level:

```sql
CREATE TYPE "media_asset_origin" AS ENUM ('merchant', 'generated', 'imported');--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "origin" "media_asset_origin" DEFAULT 'merchant' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "confidence" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "derived_from_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_derived_from_asset_id_media_assets_id_fk"
  FOREIGN KEY ("derived_from_asset_id") REFERENCES "media_assets"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "entity_media" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DELETE FROM "entity_media" AS older
USING "entity_media" AS newer
WHERE older."entity_id" = newer."entity_id"
  AND older."variant_id" IS NOT DISTINCT FROM newer."variant_id"
  AND older."media_asset_id" = newer."media_asset_id"
  AND older.ctid < newer.ctid;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_media_entity_level_unique"
  ON "entity_media" USING btree ("entity_id", "media_asset_id")
  WHERE "variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_media_variant_level_unique"
  ON "entity_media" USING btree ("entity_id", "variant_id", "media_asset_id")
  WHERE "variant_id" IS NOT NULL;
```

The de-duplication keeps the most recently inserted row per association.
Legacy writes were insert-only and the table had no creation timestamp, so the
highest physical tuple location identifies the newest row; `IS NOT DISTINCT
FROM` makes the comparison also collapse duplicates whose `variant_id` is
null. Two partial indexes replace a single covering index because Postgres
treats null values as distinct in a plain unique index, which would let
entity-level duplicates through.

Existing uploads remain merchant-origin by default. Import and convergence
callers can pass `origin: 'imported'`; generated assets can record their source
through `derived_from_asset_id` and an optional `confidence` value.
