---
name: porulle
description: "Build commerce applications with UnifiedCommerce Engine (@porulle/*). Use this skill whenever the user is building a store, plugin, storefront, POS system, marketplace, or any commerce feature using UnifiedCommerce — including configuring commerce.config.ts, creating plugins, defining routes, writing hooks, setting up adapters, working with the SDK, or deploying. Also use when you see imports from @porulle/core, @porulle/sdk, @porulle/adapter-*, or @porulle/plugin-*. Trigger even for questions like 'add a product type', 'set up checkout', 'create a loyalty plugin', or 'connect Stripe'."
---

# UnifiedCommerce Engine — Coding Agent Instructions

You are helping a developer build with UnifiedCommerce Engine (UC), a modular TypeScript commerce engine. All packages are installed from npm under the `@porulle/*` scope.

## Core Mental Model

UC has a simple architecture: **Config → Kernel → Server**.

1. `defineConfig()` produces a frozen `CommerceConfig` (plugins transform it sequentially)
2. `createServer(config)` boots a kernel (services, hooks, DB) and mounts a Hono HTTP server
3. Everything is extensible via plugins, hooks, custom routes, and adapters

The engine is **not a monolith** — developers pick only the plugins they need.

## Critical Rules

**Always do these:**
- Use `.js` extensions in all TypeScript imports (`import { Foo } from "./bar.js"`) — required by `moduleResolution: "NodeNext"`
- Return `Result<T>` from adapter methods using `Ok(value)` / `Err({ code: "ERROR_CODE", message: "..." })` — never throw exceptions from adapters. `Err()` takes an object with `code` and `message` fields, not a plain string
- Use `!= null` (loose equality) to check for both `null` and `undefined` — Drizzle returns `null` for nullable columns, not `undefined`
- Use `isNull(column)` for SQL `IS NULL` checks — never pass `null` to Drizzle's `eq()`
- Import database tables from `@porulle/core/schema` — not from internal paths
- Use the `router()` builder for plugin routes — not raw Hono route registration
- Use `toolBuilder()` for MCP tools — not manual JSON Schema definitions
- Run `bunx drizzle-kit push` after adding or modifying schema tables

**Never do these:**
- Never import from `@porulle/core/src/*` — use the public exports only
- Never use `as unknown as` double-casting — use `PluginDb`, `PluginTxFn`, `getTableColumns`, `$dynamic()` instead
- Never construct `AnalyticsScope` manually — always use `buildAnalyticsScope(actor)`
- Never pass `null` to Drizzle's `eq()` — it generates `col = NULL` (wrong), not `IS NULL`
- Never include `/api` in `router()` prefix — it is prepended automatically. Use `router("tag", "/loyalty")` not `router("tag", "/api/loyalty")`
- Never use `z.string().uuid()` — use `z.uuid()` instead

## Package Overview

| Package | Purpose | Install |
|---------|---------|---------|
| `@porulle/core` | Engine, config, plugins, hooks, router, MCP tools | Always required |
| `@porulle/adapter-postgres` | PostgreSQL database adapter | Always required |
| `@porulle/sdk` | Generic typed client, React hooks, codegen CLI | Frontend apps, scripts |
| `@porulle/adapter-stripe` | Stripe payments | Online payments |
| `@porulle/adapter-local-storage` | Local file storage | Dev / small deploys |
| `@porulle/adapter-s3` | AWS S3 storage | Production media |
| `@porulle/adapter-r2` | Cloudflare R2 storage | Edge deployments |
| `@porulle/adapter-resend` | Resend email | Transactional email |
| `@porulle/adapter-ses` | AWS SES email | High-volume email |
| `@porulle/adapter-meilisearch` | Meilisearch | Full-text search |
| `@porulle/adapter-taxjar` | TaxJar tax calculation | Tax compliance |
| `@porulle/plugin-pos` | Point-of-sale | In-store checkout |
| `@porulle/plugin-marketplace` | Multi-vendor marketplace | Marketplace apps |
| `@porulle/plugin-appointments` | Appointment scheduling | Service businesses |
| `@porulle/plugin-loyalty` | Points & tiers | Loyalty programs |
| `@porulle/plugin-gift-cards` | Gift cards | Stored value |
| `@porulle/plugin-reviews` | Product reviews | Social proof |
| `@porulle/plugin-warehouse` | Multi-warehouse ops | Supply chain |
| `@porulle/plugin-procurement` | Purchase orders & GRN | B2B procurement |
| `@porulle/plugin-production` | BOM & manufacturing | Production |
| `@porulle/plugin-notifications` | SMS/push/print | Notifications |
| `@porulle/plugin-pos-restaurant` | KDS, tables, modifiers | Restaurants |
| `@porulle/plugin-uom` | Units of measure | Multi-unit inventory |

## Minimal Setup (5 minutes)

```bash
bun add @porulle/core @porulle/adapter-postgres @hono/node-server
bun add -d drizzle-kit typescript
```

```ts title="commerce.config.ts"
import { defineConfig, Ok, type PaymentAdapter } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";

const mockPayments: PaymentAdapter = {
  providerId: "mock",
  async createPaymentIntent(p) {
    return Ok({ id: `pi_${Date.now()}`, status: "requires_capture", amount: p.amount, currency: p.currency, clientSecret: `s_${Date.now()}` });
  },
  async capturePayment(id, amt) { return Ok({ id, status: "succeeded", amountCaptured: amt ?? 0 }); },
  async refundPayment(_, amt) { return Ok({ id: `re_${Date.now()}`, status: "succeeded", amountRefunded: amt }); },
  async cancelPaymentIntent() { return Ok(undefined); },
  async verifyWebhook() { return Ok({ id: "evt", type: "payment.succeeded", data: {} }); },
};

export default defineConfig({
  storeName: "My Store",
  version: "1.0.0",
  database: { provider: "postgresql" },
  databaseAdapter: postgresAdapter({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/my_store" }),
  auth: {
    requireEmailVerification: false,
    apiKeys: { enabled: true },
    trustedOrigins: ["http://localhost:3000"],
    apiKeyScopes: {
      storefront: { prefix: "uc_pub_", description: "Public storefront", permissions: { catalog: ["read"], cart: ["create", "read", "update"], orders: ["create", "read"] } },
      admin: { prefix: "uc_adm_", description: "Full admin", permissions: { "*": ["*"] } },
    },
    roles: {
      admin: { permissions: ["*:*"] },
      customer: { permissions: ["catalog:read", "cart:create", "cart:read", "cart:update", "orders:create", "orders:read:own"] },
    },
  },
  entities: {
    product: {
      fields: [{ name: "weight", type: "number", unit: "grams" }],
      variants: { enabled: true, optionTypes: ["size", "color"] },
      fulfillment: "physical",
    },
  },
  shipping: { type: "flat", flatRate: 500, freeShippingThreshold: 10000, brackets: [], fallbackCost: 500 },
  payments: [mockPayments],
});
```

```ts title="src/server.ts"
import { serve } from "@hono/node-server";
import { createServer } from "@porulle/core";
import config from "../commerce.config.js";

const { app } = await createServer(await config);
serve({ fetch: app.fetch, port: 4000 }, () => console.log("Running on :4000"));
```

```ts title="drizzle.config.ts"
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/my_store" },
  schema: [
    "./node_modules/@porulle/core/src/kernel/database/schema.ts",
    "./node_modules/@porulle/plugin-*/src/schema.ts",
  ],
});
```

```bash
bunx drizzle-kit push && bun run src/server.ts
```

## When to Read Reference Files

The skill includes detailed reference files for specific tasks. Read them when needed:

| Task | Reference File |
|------|---------------|
| Creating a plugin (schema, hooks, routes, MCP tools, permissions) | `references/plugin-authoring.md` |
| Defining routes with the `router()` builder, or registering hooks | `references/routes-and-hooks.md` |
| Database schema, custom tables, extending core tables, Drizzle patterns | `references/schema-and-database.md` |
| Using the SDK, React hooks, consuming the API from a frontend | `references/sdk-and-frontend.md` |
| Troubleshooting common errors and known gotchas | `references/common-errors.md` |
| Deployment to Vercel, Node, Bun, Docker, Cloudflare Workers | `references/deployment.md` |

## Key Patterns (Quick Reference)

### Creating a plugin

```ts
import { defineCommercePlugin, router } from "@porulle/core";
import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";

const myTable = pgTable("my_plugin_table", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export function myPlugin() {
  return defineCommercePlugin({
    id: "my-plugin",
    version: "1.0.0",
    permissions: [{ scope: "myplugin:read", description: "Read my plugin data" }],
    schema: () => ({ myTable }),
    hooks: () => [
      { key: "orders.afterCreate", handler: async ({ result, context }) => { /* ... */ } },
    ],
    routes: (ctx) =>
      router("my-plugin", "/my-plugin", ctx)
        .get("/", { summary: "List items" })
          .permission("myplugin:read")
          .handler(async ({ db }) => {
            const rows = await db.select().from(myTable);
            return { data: rows };
          })
        .build(),
  });
}
```

### Using the SDK (typed client + codegen)

```ts
// 1. Generate types from YOUR running server:
//    bunx @porulle/sdk generate

// 2. Create a typed client against YOUR generated paths:
import { createClient } from "@porulle/sdk";
import type { paths } from "./generated/api-types";

const client = createClient<paths>({
  baseUrl: "http://localhost:3000",
  auth: { type: "api_key", key: process.env.UC_STOREFRONT_KEY ?? "" },
});

// All paths, params, bodies, and responses are compile-time checked
const { data } = await client.GET("/api/catalog/entities", {
  params: { query: { type: "product" } },
});
const { data: cart } = await client.POST("/api/carts", {
  body: { currency: "USD" },
});

// 3. For React: create typed TanStack Query hooks
import { createCommerceHooks } from "@porulle/sdk/react";
const commerce = createCommerceHooks(client);
// commerce.useQuery("get", "/api/catalog/entities", { params: ... })
```

### Testing a plugin

```ts
import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core";
import { myPlugin } from "../src/index.js";

const { app } = await createPluginTestApp(myPlugin());
const res = await app.request("http://localhost/api/my-plugin/", {
  headers: jsonHeaders(testAdminActor),
});
expect(res.status).toBe(200);
```

## OpenAPI & MCP

- **OpenAPI spec**: `GET /api/doc` (JSON) — import into Postman, Insomnia, or use for SDK generation
- **Swagger UI**: `GET /api/reference` — interactive API explorer
- **MCP endpoint**: `/mcp` — AI agents connect here for tool discovery and execution
- **System prompt**: `import { COMMERCE_AGENT_SYSTEM_PROMPT } from "@porulle/core"` — grounds AI agents in the analytics semantic layer

## Architecture Notes

- **PostgreSQL only** — the sole supported database. All schema uses `pgTable` from `drizzle-orm/pg-core`.
- **Hono framework** — the HTTP layer. Routes are Hono routes. Middleware is Hono middleware.
- **Better Auth** — handles authentication. Sessions, API keys, social login, organizations.
- **Organization-scoped** — every top-level table has `organizationId`. Single-store apps use `org_default` automatically. INSERT auto-stamps `organizationId`, but SELECT/UPDATE/DELETE must filter by `orgId` explicitly.
- **Result<T> everywhere** — core services return `{ ok: true, value } | { ok: false, error }`. Plugin services use the simpler `PluginResult<T>` (string errors). Never throw from services or adapters. In route handlers, throw errors — they're auto-caught and mapped to HTTP responses.
- **Hook pipeline** — before hooks transform data sequentially, after hooks fire side effects. Checkout has a fixed 9-step pipeline.
- **Job queue** — PostgreSQL-backed. `enqueue(taskSlug, input)` from hooks. Processed by polling or cron endpoint (`GET /api/jobs/run`).
- **Entity model** — all products/services/bundles share the `sellable_entities` table, differentiated by `type` column. Variants, custom fields, categories, and brands are child tables.
- **Plugin dependencies** — use `requires: ["other-plugin"]` in the manifest. Throws in production if missing, warns in dev.
