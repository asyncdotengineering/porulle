/**
 * App-level custom table — no plugin needed.
 *
 * Just define a Drizzle table, add it to:
 *   1. `schema` array in commerce.config.ts (runtime)
 *   2. `schema` array in drizzle.config.ts (migrations)
 *
 * Uses @porulle/core/schema for FK references to core tables.
 */

import { integer, pgTable, text, timestamp, uuid } from "@porulle/core/drizzle";
import { sellableEntities, customers } from "@porulle/core/schema";

export const reviews = pgTable("reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityId: uuid("entity_id")
    .notNull()
    .references(() => sellableEntities.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id")
    .references(() => customers.id, { onDelete: "set null" }),
  rating: integer("rating").notNull(),
  title: text("title"),
  body: text("body"),
  status: text("status", { enum: ["pending", "approved", "rejected"] })
    .notNull()
    .default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
