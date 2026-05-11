# Schema and Database Reference

## Database: PostgreSQL Only

UC uses PostgreSQL exclusively via Drizzle ORM. All schema uses `pgTable` from `drizzle-orm/pg-core`. All monetary amounts are stored as integers in the smallest currency unit (cents).

## Core Tables

Import core tables from `@porulle/core/schema`:

```ts
import {
  sellableEntities,    // Products, services, subscriptions
  sellableAttributes,  // Translatable title/description per locale
  sellableCustomFields, // Dynamic key-value fields
  categories,          // Hierarchical categories
  entityCategories,    // Entity-category junction
  brands,              // Brand records
  entityBrands,        // Entity-brand junction
  optionTypes,         // Size, Color, etc.
  optionValues,        // S, M, L, Red, Blue, etc.
  variants,            // SKU-level variants
  variantOptionValues, // Variant-option junction
  inventoryLevels,     // Stock per entity+variant+warehouse
  warehouses,          // Physical warehouses
  carts,               // Shopping carts
  cartLineItems,       // Items in cart
  orders,              // Customer orders
  orderLineItems,      // Items in order
  customers,           // Customer profiles
  customerAddresses,   // Shipping/billing addresses
  prices,              // Tiered pricing rules
  priceModifiers,      // Discounts, markups
  promotions,          // Promo codes and auto-discounts
  mediaAssets,         // Images, videos, documents
  webhookEndpoints,    // Webhook registrations
  commerceJobs,        // Background job queue
} from "@porulle/core/schema";
```

## Creating Custom Tables

```ts
import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { sellableEntities, customers } from "@porulle/core/schema";

export const reviews = pgTable("reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityId: uuid("entity_id").notNull()
    .references(() => sellableEntities.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id")
    .references(() => customers.id, { onDelete: "set null" }),
  rating: integer("rating").notNull(),
  body: text("body"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Register in `commerce.config.ts`:

```ts
export default defineConfig({
  schema: [{ reviews }],
  // ...
});
```

Add to `drizzle.config.ts`:

```ts
schema: [
  "./node_modules/@porulle/core/src/kernel/database/schema.ts",
  "./node_modules/@porulle/plugin-*/src/schema.ts",
  "./src/schema/reviews.ts",  // Your custom schema
],
```

Then run: `bunx drizzle-kit push`

## Extending Core Tables

Use `mergeExtraColumns` from `@porulle/core/schema-utils`:

```ts
import { pgTable, text, uuid, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { mergeExtraColumns } from "@porulle/core/schema-utils";

// Must re-declare ALL base columns
const baseColumns = {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status", { enum: ["draft", "active", "archived", "discontinued"] }).notNull().default("draft"),
  isVisible: boolean("is_visible").notNull().default(false),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
};

export const extendedSellableEntities = pgTable(
  "sellable_entities",
  mergeExtraColumns(baseColumns, () => ({
    supplierCode: text("supplier_code"),
    countryOfOrigin: text("country_of_origin"),
  })),
);
```

Do NOT re-declare index definitions from the core table — it causes duplicate index name collisions.

## Organization Scoping

Every top-level table has `organizationId` (text, NOT NULL, FK to `organization.id`). Single-store apps use `org_default` automatically. Services resolve the org from the actor context — callers never pass `orgId` as a separate parameter.

## Drizzle Query Patterns

```ts
import { eq, and, or, desc, sql, isNull, inArray } from "drizzle-orm";

// Select
const [row] = await db.select().from(myTable).where(eq(myTable.id, id));

// Insert
const [created] = await db.insert(myTable).values({ name: "foo" }).returning();

// Update
const [updated] = await db.update(myTable).set({ name: "bar" }).where(eq(myTable.id, id)).returning();

// Delete
await db.delete(myTable).where(eq(myTable.id, id));

// IS NULL (never use eq(col, null))
await db.select().from(myTable).where(isNull(myTable.deletedAt));

// Upsert
await db.insert(myTable).values({ id, name: "foo" })
  .onConflictDoUpdate({ target: myTable.id, set: { name: "bar" } });

// Transactions
await ctx.database.transaction(async (tx) => {
  const [row] = await tx.select().from(myTable).where(eq(myTable.id, id)).for("update");
  await tx.update(myTable).set({ count: sql`${myTable.count} + 1` }).where(eq(myTable.id, id));
});
```

## Type-Safe Database Access

In plugins, use `PluginDb` and `PluginTxFn` from core:

```ts
import type { PluginDb, PluginTxFn } from "@porulle/core";

class MyService {
  constructor(private db: PluginDb) {}

  async getItems() {
    return this.db.select().from(myTable);
  }
}
```

Never use `as unknown as` for database types. `PluginContext.database.db` is already typed as `PluginDb`.
