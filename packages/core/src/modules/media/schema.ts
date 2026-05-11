import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";
import { sellableEntities, variants } from "../catalog/schema.js";

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    width: integer("width"),
    height: integer("height"),
    alt: text("alt"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_media_assets_org").on(table.organizationId),
  }),
);

export const entityMedia = pgTable("entity_media", {
  entityId: uuid("entity_id")
    .references(() => sellableEntities.id, { onDelete: "cascade" })
    .notNull(),
  variantId: uuid("variant_id").references(() => variants.id, {
    onDelete: "cascade",
  }),
  mediaAssetId: uuid("media_asset_id")
    .references(() => mediaAssets.id, { onDelete: "cascade" })
    .notNull(),
  role: text("role", {
    enum: ["primary", "gallery", "thumbnail", "video", "document"],
  }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});
