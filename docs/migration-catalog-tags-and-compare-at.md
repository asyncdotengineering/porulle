# Catalog tags and compare-at price migration

Core consumers own their Drizzle migrations. The migration adds the org-scoped
tag tables the channel convergence writes into and the compare-at column on
prices:

```sql
CREATE TABLE "tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "display_name" text NOT NULL
);--> statement-breakpoint
CREATE INDEX "idx_tags_org" ON "tags" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_slug_unique" ON "tags" USING btree ("organization_id", "slug");--> statement-breakpoint
CREATE TABLE "entity_tags" (
  "entity_id" uuid NOT NULL REFERENCES "sellable_entities"("id") ON DELETE cascade,
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "entity_tags_entity_tag_unique" ON "entity_tags" USING btree ("entity_id", "tag_id");--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "compare_at_amount" integer;
```

Both tables start empty and the new column is nullable, so no backfill is
required. Entity revisions written after this migration snapshot tag links
beside categories and brands; snapshots written earlier restore with no tag
changes.
