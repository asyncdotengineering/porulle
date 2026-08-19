# Runtime entity field definitions migration

Core consumers own their Drizzle migrations. The migration adds the
organization-scoped runtime definition table, with a unique field name per
organization and entity type, typed field metadata, and archive-only lifecycle:

```sql
CREATE TABLE "entity_field_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "entity_type" text NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "unit" text,
  "options" jsonb,
  "target" text,
  "filterable" boolean DEFAULT false NOT NULL,
  "localized" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "entity_field_definitions" ADD CONSTRAINT "entity_field_definitions_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_field_definitions_org_type_name_unique"
  ON "entity_field_definitions" USING btree ("organization_id", "entity_type", "name");--> statement-breakpoint
CREATE INDEX "idx_entity_field_definitions_organization"
  ON "entity_field_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_entity_field_definitions_entity_type"
  ON "entity_field_definitions" USING btree ("organization_id", "entity_type");
```

The `type` values are `text`, `number`, `boolean`, `date`, `json`, `relation`,
and `select`. Runtime definitions layer over code-config definitions at read
time. Active rows can add fields and amend `options`, `filterable`, and
`localized`; archived rows are ignored for new writes, while values already
stored in `sellable_custom_fields` remain readable. Code-defined fields cannot
be archived through the runtime API.
