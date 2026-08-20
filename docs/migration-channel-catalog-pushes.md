# Channel catalog push migration

Core consumers own their Drizzle migrations. The migration adds durable
outbound catalog push state used by the `channel/push-catalog` job:

```sql
CREATE TABLE "channel_catalog_pushes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "store_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "payload_snapshot" jsonb,
  "state" text DEFAULT 'pending' NOT NULL,
  "failure_kind" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "channel_catalog_pushes" ADD CONSTRAINT "channel_catalog_pushes_store_id_connected_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."connected_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_catalog_pushes_org" ON "channel_catalog_pushes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_channel_catalog_pushes_store" ON "channel_catalog_pushes" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "idx_channel_catalog_pushes_state" ON "channel_catalog_pushes" USING btree ("organization_id","state");--> statement-breakpoint
CREATE INDEX "idx_channel_catalog_pushes_entity" ON "channel_catalog_pushes" USING btree ("organization_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_catalog_pushes_store_entity_unique" ON "channel_catalog_pushes" USING btree ("store_id","entity_id");--> statement-breakpoint
CREATE TABLE "channel_catalog_push_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "push_id" uuid NOT NULL,
  "from_state" text NOT NULL,
  "to_state" text NOT NULL,
  "reason" text,
  "changed_by" text NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "channel_catalog_push_events" ADD CONSTRAINT "channel_catalog_push_events_push_id_channel_catalog_pushes_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."channel_catalog_pushes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_catalog_push_events_org" ON "channel_catalog_push_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_channel_catalog_push_events_push" ON "channel_catalog_push_events" USING btree ("push_id");
```

No backfill is required. Rows are created on first push attempt for each
`(store, entity)` pair. The `payload_snapshot` column records the per-field
payload that was actually sent; the job always rebuilds outbound items from
current canonical state at execution time.
