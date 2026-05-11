# Plugin Authoring Reference

## Plugin Structure

A plugin is a config transform function. `defineCommercePlugin()` converts a manifest into a `CommercePlugin`.

```ts
import { defineCommercePlugin } from "@porulle/core";

export function myPlugin(options?: MyPluginOptions) {
  return defineCommercePlugin({
    id: "my-plugin",
    version: "1.0.0",
    requires: [],                    // Optional: plugin dependencies
    permissions: [],                 // Permission scopes
    schema: () => ({ ... }),         // Drizzle pgTable definitions
    hooks: () => [...],              // Hook registrations
    routes: (ctx) => [...],          // REST route registrations
    mcpTools: (ctx) => [...],        // MCP tool definitions
    analyticsModels: () => [...],    // Analytics model definitions
  });
}
```

Plugins are applied sequentially during `defineConfig()`. Each plugin receives the full config and returns a modified copy. They compose naturally: two plugins that both add hooks to `checkout.beforeCreate` both run.

## Permissions

Declare scopes your plugin enforces:

```ts
permissions: [
  { scope: "loyalty:read", description: "View loyalty points" },
  { scope: "loyalty:write", description: "Redeem loyalty points" },
],
```

Enforce on routes via `.permission("loyalty:read")`. The engine checks the actor's role permissions.

## Schema

Return Drizzle `pgTable` objects. Keys must not collide with core table exports.

```ts
import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { customers } from "@porulle/core/schema";

const loyaltyPoints = pgTable("loyalty_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  customerId: uuid("customer_id").notNull().unique()
    .references(() => customers.id, { onDelete: "cascade" }),
  points: integer("points").notNull().default(0),
  tier: text("tier", { enum: ["bronze", "silver", "gold", "platinum"] }).notNull().default("bronze"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// In the manifest:
schema: () => ({ loyaltyPoints }),
```

After adding schema, the developer must:
1. Add the schema file path to `drizzle.config.ts`
2. Run `bunx drizzle-kit push`

## Hooks

Return an array of `{ key, handler }` objects:

```ts
hooks: () => [
  {
    key: "orders.afterCreate",
    handler: async ({ result, context }) => {
      const order = result as { customerId?: string; grandTotal: number };
      if (!order.customerId) return;
      // Award loyalty points, send notification, etc.
      await context.db.insert(loyaltyPoints).values({ ... });
    },
  },
  {
    key: "checkout.beforePayment",
    handler: async ({ data, context }) => {
      // Modify checkout data before payment authorization
      return data; // Must return data for before hooks
    },
  },
],
```

Available hook keys:
- **Catalog**: `catalog.beforeCreate`, `catalog.afterCreate`, `catalog.beforeUpdate`, `catalog.afterUpdate`, `catalog.beforeRead`, `catalog.afterRead`, `catalog.beforeList`, `catalog.afterList`, `catalog.afterDelete`
- **Cart**: `cart.beforeAddItem`, `cart.afterAddItem`, `cart.beforeRemoveItem`, `cart.afterRemoveItem`, `cart.beforeUpdateQuantity`, `cart.afterUpdateQuantity`
- **Checkout**: `checkout.beforePayment`, `checkout.beforeCreate`, `checkout.afterCreate`
- **Orders**: `orders.beforeCreate`, `orders.afterCreate`, `orders.beforeStatusChange`, `orders.afterStatusChange`
- **Inventory**: `inventory.afterAdjust`
- **Customers**: `customers.afterCreate`, `customers.afterUpdate`
- **Pricing**: `pricing.afterCreate`, `pricing.afterUpdate`
- **Promotions**: `promotions.afterCreate`, `promotions.afterUpdate`
- **Fulfillment**: `fulfillment.afterCreate`

Before hooks MUST return the (possibly modified) data. After hooks return void.

## Routes (router() builder)

```ts
import { router } from "@porulle/core";
import { z } from "zod";

routes: (ctx) =>
  router("my-plugin", "/my-plugin", ctx)
    // GET /api/my-plugin/items
    .get("/items", { summary: "List items" })
      .permission("myplugin:read")
      .query(z.object({ page: z.coerce.number().default(1) }))
      .handler(async ({ db, query }) => {
        const rows = await db.select().from(myTable).limit(20).offset((query.page - 1) * 20);
        return { data: rows };
      })

    // POST /api/my-plugin/items
    .post("/items", { summary: "Create item" })
      .auth()
      .permission("myplugin:write")
      .input(z.object({ name: z.string().min(1) }))
      .handler(async ({ input, db, actor }) => {
        const [row] = await db.insert(myTable).values({ name: input.name }).returning();
        return { data: row };
      })

    // GET /api/my-plugin/items/{id}
    .get("/items/{id}", { summary: "Get item" })
      .permission("myplugin:read")
      .handler(async ({ db, params }) => {
        const [row] = await db.select().from(myTable).where(eq(myTable.id, params.id));
        if (!row) throw new Error("Not found");
        return { data: row };
      })

    .build(),
```

Handler context:
- `input` — Validated request body (from `.input()`)
- `query` — Validated query params (from `.query()`)
- `params` — Path parameters (auto-extracted from `{id}` patterns)
- `actor` — Authenticated user (guaranteed non-null after `.auth()` or `.permission()`)
- `orgId` — Organization ID
- `db` — Scoped Drizzle database instance
- `services` — Kernel service container
- `logger` — Per-request structured logger
- `requestId` — Unique request ID

Routes auto-appear in OpenAPI spec at `/api/doc` and Swagger UI at `/api/reference`.

## MCP Tools (toolBuilder)

```ts
import { toolBuilder } from "@porulle/core";
import { z } from "zod";

mcpTools: (ctx) => {
  const db = ctx.database.db;
  if (!db) return [];

  const t = toolBuilder("my-plugin", "Manage my plugin features.");

  t.action("list", "List all items.")
    .input(z.object({ limit: z.number().optional() }))
    .handler(async ({ limit }) => {
      return db.select().from(myTable).limit(limit ?? 10);
    });

  t.action("get", "Get item by ID.")
    .input(z.object({ id: z.string().describe("Item UUID") }))
    .handler(async ({ id }) => {
      const [row] = await db.select().from(myTable).where(eq(myTable.id, id));
      return row ?? { error: "Not found" };
    });

  return t.build(ctx);
},
```

The `toolBuilder` automatically creates the `action` enum, merges Zod schemas, generates descriptions, and handles dispatch.

## Analytics Models

```ts
import type { AnalyticsModel } from "@porulle/core";

const myModel: AnalyticsModel = {
  name: "LoyaltyPoints",
  table: "loyalty_points",
  measures: {
    totalPoints: { sql: "points", type: "sum" },
    memberCount: { type: "count" },
  },
  dimensions: {
    tier: { sql: "tier", type: "string" },
    createdAt: { sql: "created_at", type: "time" },
  },
};

// In manifest:
analyticsModels: () => [myModel],
```

## PluginContext

The `ctx` parameter in `routes` and `mcpTools` provides:

```ts
interface PluginContext {
  config: CommerceConfig;
  services: Record<string, unknown>;
  database: {
    db: PluginDb;                                    // Typed Drizzle instance
    transaction<T>(fn: (tx: PluginDb) => Promise<T>): Promise<T>;
  };
  logger: { info, warn, error };
}
```

`ctx.database.db` is already typed as `PluginDb` — no casting needed.

## Testing

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createPluginTestApp, jsonHeaders, testAdminActor, testNoPermActor } from "@porulle/core";
import { myPlugin } from "../src/index.js";

describe("my plugin", () => {
  let app: Awaited<ReturnType<typeof createPluginTestApp>>["app"];

  beforeAll(async () => {
    const result = await createPluginTestApp(myPlugin());
    app = result.app;
  });

  it("lists items", async () => {
    const res = await app.request("http://localhost/api/my-plugin/items", {
      headers: jsonHeaders(testAdminActor),
    });
    expect(res.status).toBe(200);
  });

  it("returns 403 without permission", async () => {
    const res = await app.request("http://localhost/api/my-plugin/items", {
      headers: jsonHeaders(testNoPermActor),
    });
    expect(res.status).toBe(403);
  });
});
```

`createPluginTestApp` boots PGlite (in-memory PostgreSQL), pushes the full schema, and wires routes. No running server or Docker needed.

Available test actors: `testAdminActor` (`*:*`), `testStaffActor`, `testCustomerActor`, `testNoPermActor` (no permissions).
