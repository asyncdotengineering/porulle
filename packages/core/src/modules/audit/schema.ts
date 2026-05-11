import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

export const auditLog = pgTable(
  "commerce_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull().default("{}"),
    actorId: text("actor_id"),
    actorType: text("actor_type"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    entityIdx: index("idx_audit_entity").on(table.entityType, table.entityId),
    orgIdx: index("idx_audit_org").on(table.organizationId),
  }),
);
