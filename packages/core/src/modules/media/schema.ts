import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";
import { sellableEntities, variants } from "../catalog/schema.js";

export const mediaAssetOrigin = pgEnum("media_asset_origin", ["merchant", "generated", "imported"]);
export type MediaAssetOrigin = (typeof mediaAssetOrigin.enumValues)[number];

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
    origin: mediaAssetOrigin("origin").notNull().default("merchant"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    derivedFromAssetId: uuid("derived_from_asset_id").references((): AnyPgColumn => mediaAssets.id, {
      onDelete: "set null",
    }),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Two partial indexes instead of one NULLS DISTINCT index: Postgres treats
  // null variant ids as distinct, so a single index cannot reject duplicate
  // entity-level rows.
  entityLevelUnique: uniqueIndex("entity_media_entity_level_unique")
    .on(table.entityId, table.mediaAssetId)
    .where(sql`${table.variantId} IS NULL`),
  variantLevelUnique: uniqueIndex("entity_media_variant_level_unique")
    .on(table.entityId, table.variantId, table.mediaAssetId)
    .where(sql`${table.variantId} IS NOT NULL`),
}));
