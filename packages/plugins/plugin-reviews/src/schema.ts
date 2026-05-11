import { pgTable, uuid, text, integer, boolean, timestamp, index } from "@porulle/core/drizzle";

export const customerReviews = pgTable("customer_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  customerId: uuid("customer_id"),
  entityId: uuid("entity_id").notNull(),
  orderId: uuid("order_id"),
  rating: integer("rating").notNull(),
  title: text("title"),
  body: text("body"),
  status: text("status", { enum: ["pending", "approved", "rejected"] })
    .notNull()
    .default("pending"),
  isVerified: boolean("is_verified").notNull().default(false),
  isPublished: boolean("is_published").notNull().default(false),
  response: text("response"),
  responseBy: text("response_by"),
  responseAt: timestamp("response_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_customer_reviews_org").on(table.organizationId),
  entityIdx: index("idx_customer_reviews_entity").on(table.entityId),
  statusIdx: index("idx_customer_reviews_status").on(table.status),
}));
