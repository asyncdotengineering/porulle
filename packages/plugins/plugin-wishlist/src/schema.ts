import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "@porulle/core/drizzle";
import { organization } from "@porulle/core/auth-schema";
import { sellableEntities } from "@porulle/core/schema";

export const wishlistItems = pgTable("wishlist_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  entityId: uuid("entity_id")
    .notNull()
    .references(() => sellableEntities.id, { onDelete: "cascade" }),
  note: text("note"),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_wishlist_items_org").on(table.organizationId),
  userIdx: index("idx_wishlist_items_user").on(table.organizationId, table.userId),
  orgUserEntityUnique: uniqueIndex("wishlist_items_org_user_entity_unique")
    .on(table.organizationId, table.userId, table.entityId),
}));
