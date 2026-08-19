# Catalog field ownership migration

Core consumers own their Drizzle migrations. The migration adds the org-scoped
ownership state used to decide which side may write each concrete catalog field:

```sql
CREATE TYPE "catalog_field_owner" AS ENUM ('platform', 'store', 'shared');--> statement-breakpoint
CREATE TABLE "catalog_field_ownership" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "entity_id" uuid NOT NULL REFERENCES "sellable_entities"("id") ON DELETE cascade,
  "variant_id" uuid REFERENCES "variants"("id") ON DELETE cascade,
  "store_id" text,
  "field_path" text NOT NULL,
  "owner" "catalog_field_owner" NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "catalog_field_ownership" ADD CONSTRAINT "catalog_field_ownership_key"
  UNIQUE NULLS NOT DISTINCT ("organization_id", "entity_id", "variant_id", "store_id", "field_path");--> statement-breakpoint
CREATE INDEX "idx_catalog_field_ownership_entity_store_field"
  ON "catalog_field_ownership" USING btree ("entity_id", "store_id", "variant_id", "field_path");
```

The table starts empty and no backfill is required. Imported concrete field paths
can be seeded with `seedImportedFieldOwnership`; repeated seeding is idempotent.
A missing row is returned as `undefined` by the catalog service and represents an
unowned field; enforcement and the inbound/outbound fallback behavior belong to
the convergence and push tasks.

Resolution precedence when several rows cover one field path is deterministic,
most-specific wins:

| Tier | Row shape |
| --- | --- |
| 3 | variant-scoped, store-specific |
| 2 | variant-scoped, all stores |
| 1 | entity-level, store-specific |
| 0 | entity-level, all stores |

Bulk resolution (`resolveFieldOwners`) is entity-level and does not consult
variant-scoped rows. The `UNIQUE NULLS NOT DISTINCT` constraint requires
PostgreSQL 15 or later.

Ownership is synchronization state rather than product-information state, so it
is not included in sellable entity revisions and revision restores do not change
ownership rows.
