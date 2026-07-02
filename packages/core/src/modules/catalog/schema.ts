import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

export const sellableEntities = pgTable(
  "sellable_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    slug: text("slug").notNull(),
    status: text("status", {
      enum: ["draft", "active", "archived", "discontinued"],
    })
      .notNull()
      .default("draft"),
    isVisible: boolean("is_visible").notNull().default(false),
    // Tax class name (issue #57) — maps to tax_classes.name at checkout;
    // a variant-level taxClass overrides this. Null = the org's default class.
    taxClass: text("tax_class"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => ({
    typeIdx: index("idx_sellable_entities_type").on(table.type),
    statusIdx: index("idx_sellable_entities_status").on(table.status),
    slugIdx: index("idx_sellable_entities_slug").on(table.slug),
    orgIdx: index("idx_sellable_entities_org").on(table.organizationId),
    orgSlugUnique: uniqueIndex("sellable_entities_org_slug_unique").on(table.organizationId, table.slug),
  }),
);

export const sellableAttributes = pgTable(
  "sellable_attributes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .references(() => sellableEntities.id, { onDelete: "cascade" })
      .notNull(),
    locale: text("locale").notNull().default("en"),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    description: text("description"),
    richDescription: jsonb("rich_description"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
  },
  (table) => ({
    entityLocaleIdx: index("idx_sellable_attrs_entity_locale").on(
      table.entityId,
      table.locale,
    ),
  }),
);

export const sellableCustomFields = pgTable(
  "sellable_custom_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .references(() => sellableEntities.id, { onDelete: "cascade" })
      .notNull(),
    fieldName: text("field_name").notNull(),
    fieldType: text("field_type", {
      enum: ["text", "number", "boolean", "date", "json", "relation"],
    }).notNull(),
    textValue: text("text_value"),
    numberValue: integer("number_value"),
    booleanValue: boolean("boolean_value"),
    dateValue: timestamp("date_value", { withTimezone: true }),
    jsonValue: jsonb("json_value"),
  },
  (table) => ({
    entityFieldIdx: index("idx_custom_fields_entity_field").on(
      table.entityId,
      table.fieldName,
    ),
    textValueIdx: index("idx_custom_fields_text").on(
      table.fieldName,
      table.textValue,
    ),
    numberValueIdx: index("idx_custom_fields_number").on(
      table.fieldName,
      table.numberValue,
    ),
  }),
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    // Self-referential FK — Drizzle requires AnyPgColumn for circular references.
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "set null",
    }),
    slug: text("slug").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    // active | archived. Soft-delete without cascading entity_categories.
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (table) => ({
    orgIdx: index("idx_categories_org").on(table.organizationId),
    orgSlugUnique: uniqueIndex("categories_org_slug_unique").on(table.organizationId, table.slug),
  }),
);

export const entityCategories = pgTable("entity_categories", {
  entityId: uuid("entity_id")
    .references(() => sellableEntities.id, { onDelete: "cascade" })
    .notNull(),
  categoryId: uuid("category_id")
    .references(() => categories.id, { onDelete: "cascade" })
    .notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => ({
  entityCategoryUnique: uniqueIndex("entity_categories_entity_category_unique").on(table.entityId, table.categoryId),
}));

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (table) => ({
    orgIdx: index("idx_brands_org").on(table.organizationId),
    orgSlugUnique: uniqueIndex("brands_org_slug_unique").on(table.organizationId, table.slug),
  }),
);

export const entityBrands = pgTable("entity_brands", {
  entityId: uuid("entity_id")
    .references(() => sellableEntities.id, { onDelete: "cascade" })
    .notNull(),
  brandId: uuid("brand_id")
    .references(() => brands.id, { onDelete: "cascade" })
    .notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => ({
  entityBrandUnique: uniqueIndex("entity_brands_entity_brand_unique").on(table.entityId, table.brandId),
}));

export const optionTypes = pgTable("option_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityId: uuid("entity_id")
    .references(() => sellableEntities.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  displayName: text("display_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const optionValues = pgTable("option_values", {
  id: uuid("id").defaultRandom().primaryKey(),
  optionTypeId: uuid("option_type_id")
    .references(() => optionTypes.id, { onDelete: "cascade" })
    .notNull(),
  value: text("value").notNull(),
  displayValue: text("display_value").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
});

export const variants = pgTable("variants", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityId: uuid("entity_id")
    .references(() => sellableEntities.id, { onDelete: "cascade" })
    .notNull(),
  sku: text("sku").unique(),
  barcode: text("barcode"),
  // Overrides the entity's taxClass when set (issue #57).
  taxClass: text("tax_class"),
  status: text("status", { enum: ["active", "discontinued"] })
    .notNull()
    .default("active"),
  sortOrder: integer("sort_order").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
}, (table) => ({
  barcodeIdx: index("idx_variants_barcode").on(table.barcode),
  skuIdx: index("idx_variants_sku").on(table.sku),
}));

export const variantOptionValues = pgTable("variant_option_values", {
  variantId: uuid("variant_id")
    .references(() => variants.id, { onDelete: "cascade" })
    .notNull(),
  optionValueId: uuid("option_value_id")
    .references(() => optionValues.id, { onDelete: "cascade" })
    .notNull(),
}, (table) => ({
  variantOptionValueUnique: uniqueIndex("variant_option_values_variant_option_unique").on(table.variantId, table.optionValueId),
}));
