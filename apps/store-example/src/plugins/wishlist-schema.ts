import { pgTable, uuid, text, timestamp } from "@porulle/core/drizzle";

export const wishlistItems = pgTable("wishlist_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  customerId: text("customer_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  note: text("note"),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
});
