# Sellable entity revisions migration

Core consumers own their Drizzle migrations. The migration adds the full-copy
sellable entity revision store, including the typed reason enum, actor
attribution, retention pin, and per-entity revision constraint:

```sql
CREATE TYPE "sellable_entity_revision_reason" AS ENUM ('create', 'update', 'import', 'enrichment', 'push', 'restore');--> statement-breakpoint
CREATE TABLE "sellable_entity_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "reason" "sellable_entity_revision_reason" NOT NULL,
  "pinned" boolean DEFAULT false NOT NULL,
  "actor_id" text,
  "actor_type" text,
  "request_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "sellable_entity_revisions" ADD CONSTRAINT "sellable_entity_revisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "sellable_entity_revisions" ADD CONSTRAINT "sellable_entity_revisions_entity_id_sellable_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "sellable_entities"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "sellable_entity_revisions_entity_revision_unique" ON "sellable_entity_revisions" USING btree ("entity_id", "revision");--> statement-breakpoint
CREATE INDEX "idx_sellable_entity_revisions_entity_created" ON "sellable_entity_revisions" USING btree ("entity_id", "created_at");--> statement-breakpoint
CREATE INDEX "idx_sellable_entity_revisions_organization" ON "sellable_entity_revisions" USING btree ("organization_id");
```

Revision 1 is pinned by the catalog service and is spared by retention even if
the pin value is changed. The catalog service trims unpinned revisions older
than 90 days, compares canonical snapshots before inserting, and appends a
restore revision after reapplying a selected snapshot.
