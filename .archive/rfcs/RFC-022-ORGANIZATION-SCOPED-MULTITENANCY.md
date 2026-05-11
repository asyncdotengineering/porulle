# RFC-022: Organization-Scoped Multi-Tenancy

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-18
- **Scope:** `packages/core/src/modules/*/schema.ts`, `packages/core/src/modules/*/service.ts`, `packages/core/src/auth/`, `packages/core/src/kernel/database/`, `packages/db/` (new package)
- **Motivation:** Every protocol in the agentic commerce stack (ACP, UCP, AP2, A2A) requires a "Business" or "Merchant" identity that scopes all commercial data. Every vertical SaaS use case (restaurants, fitness, fashion) requires tenant isolation. Better Auth's organization plugin already provides the auth/session layer (`session.activeOrganizationId` populates `Actor.organizationId`), but zero core tables carry an `organizationId` column and zero service methods apply org-scoped filtering. This RFC adds `organizationId` to all top-level core tables, provides a `defineTable` abstraction that auto-injects the column, introduces `@unifiedcommerce/db` as the single import for all database work, and provides a scoped DB proxy so queries are automatically filtered by organization without manual intervention.
- **Breaking changes:** Yes. All unique constraints on `slug`, `code`, `email` become composite unique on `(organizationId, slug)`. Schema definitions migrate from raw `pgTable` to `defineTable`. No backward compatibility is maintained; no production deployments exist.
- **Prior art:** Astro DB (`defineTable` + `column` wrapping Drizzle with auto-injected fields), Blitz.js multitenancy (organizationId on every table, session-level org context), Activepieces (`entitiesMustBeOwnedByCurrentProject` guard on every query), Prisma Client Extensions (proxy-based automatic tenant filtering), Django `django-multitenant` (automatic queryset scoping via middleware)
- **Estimated effort:** 7-10 engineering-days

---

## 0. Terminology: Organization = Store

Throughout this RFC, "organization" means **a store**. One organization is one store -- one catalog, one set of orders, one set of customers, one set of prices.

| Concept | Meaning |
|---------|---------|
| **Organization** | A store. The top-level data boundary. |
| **Default organization** (`org_default`) | The single store that UnifiedCommerce creates automatically on first boot. Every starter (fashion, headless, API) begins as one store. |
| **Multi-organization** | Multiple stores on one UC instance. A developer building a SaaS platform (like Shopify, like Foodbook.lk) creates one organization per customer (per restaurant, per fashion brand, per gym). |

**The single-store case (99% of starters):** A developer clones the fashion starter, runs `bun run dev`. UC auto-creates `org_default`. All products, orders, customers belong to this one store. The developer never thinks about organizations. Everything works exactly as it does today -- no extra config, no org switching, no multi-tenant complexity.

**The multi-store case (vertical SaaS builders):** A developer building "Restaurant Platform Inc." on UC creates one organization per restaurant that signs up. Restaurant A's menu, orders, and customers are invisible to Restaurant B. The developer uses Better Auth's organization API (`POST /api/auth/organization/create`) and the `set-active` endpoint to switch context.

The word "organization" is used instead of "store" in the code because Better Auth's plugin is called `organization`. Renaming it would break Better Auth compatibility. But mentally: **organization = store**.

---

## 1. Problem

### 1.1 The Auth Layer Exists; The Data Layer Does Not

Better Auth's organization plugin is integrated and active. The session carries `activeOrganizationId`. The auth middleware resolves it into `Actor.organizationId`. The `TxContext` carries the actor through every service method.

But the data is completely unscoped:

```typescript
// Current: catalog.list() returns ALL entities across ALL organizations
async list(params: ListParams, ctx?: TxContext): Promise<Result<PaginatedResult>> {
  // No reference to actor.organizationId anywhere
  const result = await this.repo.findEntities(params.filter, params.sort, params.pagination, ctx);
  return Ok(result);
}
```

A user authenticated as a member of "Sofa Society" and a user authenticated as a member of "Nordic Furniture" see the same catalog, the same orders, the same customers. The organization boundary is cosmetic.

### 1.2 Plugin Developer Burden

If we simply add `organizationId` to tables and require plugin developers to manually pass it through every query, the DX is poor:

```typescript
// BAD: every query, every method, every time
const orgId = resolveOrgId(actor, ctx);
const cards = await repo.findByCode(orgId, code);
const list = await repo.list(orgId, filters);
await repo.create(orgId, { ... });
```

This is repetitive, error-prone, and easy to forget. A single missed `orgId` is a data leak between tenants. Other frameworks solve this transparently:

- **Astro DB**: wraps Drizzle's `pgTable` with `defineTable` -- auto-injects fields, developers never see the raw ORM
- **Prisma Client Extensions**: proxy-based automatic tenant filtering -- developers write normal queries
- **Django `django-multitenant`**: overrides the model manager's `get_queryset()` to auto-filter
- **Activepieces**: `entitiesMustBeOwnedByCurrentProject` guard on every API response

UC must make organization scoping **invisible** to plugin developers.

### 1.3 Unique Constraints Will Break

Six tables have globally unique constraints that become invalid in multi-tenant:

| Table | Current Constraint | Problem |
|-------|-------------------|---------|
| `sellable_entities` | `slug` UNIQUE | Two orgs cannot both have a product with slug `astrid-curve` |
| `categories` | `slug` UNIQUE | Two orgs cannot both have a category `sofas` |
| `brands` | `slug` UNIQUE | Two orgs cannot both have a brand `arm-chairs` |
| `warehouses` | `code` UNIQUE | Two orgs cannot both have warehouse code `EU-CPH` |
| `promotions` | `code` UNIQUE | Two orgs cannot both have promotion code `WELCOME15` |
| `customers` | `email` UNIQUE | Same customer email across two orgs is blocked |

All six must become composite unique on `(organizationId, slug/code/email)`.

### 1.4 Protocol Requirements

| Protocol | Requirement | Maps To |
|----------|-------------|---------|
| ACP (Stripe+OpenAI) | "Business" participant is merchant of record | Organization |
| UCP (Google) | "Merchant" retains customer data ownership | Organization |
| AP2 (Google) | Mandates scoped to specific merchant | Organization |
| A2A (Google) | Agent Cards declare identity and organization | Organization |
| MCP | Tools operate within a context | Organization scopes tool actions |

Without `organizationId`, UC cannot implement any of these protocols correctly.

---

## 2. Design

### 2.1 Three Layers of Abstraction

```
Layer 3: @unifiedcommerce/db     -- single import for all database work
Layer 2: defineTable()            -- auto-injects organizationId, timestamps, id
Layer 1: Scoped DB Proxy          -- auto-filters queries, auto-stamps inserts
```

Each layer makes organization scoping more invisible:
- `defineTable` means the developer never writes the `organizationId` column
- The scoped DB proxy means the developer never writes `WHERE organization_id = ?`
- `@unifiedcommerce/db` means the developer never imports from `drizzle-orm` directly

### 2.2 `@unifiedcommerce/db` Package

A new package that re-exports everything a plugin developer needs for database work. Same pattern as Astro's `astro:db`.

```
Pseudocode: @unifiedcommerce/db exports

MODULE @unifiedcommerce/db:
  // UC abstractions
  EXPORT defineTable       -- wraps pgTable with auto-injected organizationId, id, timestamps
  EXPORT column            -- namespace for column builders (column.text, column.integer, etc.)

  // Drizzle query operators (re-exported)
  EXPORT eq, ne, gt, gte, lt, lte
  EXPORT and, or, not
  EXPORT like, ilike, notLike
  EXPORT inArray, notInArray
  EXPORT between, notBetween
  EXPORT isNull, isNotNull
  EXPORT exists, notExists
  EXPORT sql
  EXPORT asc, desc
  EXPORT count, sum, avg, min, max
  EXPORT countDistinct, sumDistinct, avgDistinct
  EXPORT alias
```

#### 2.2.1 Blueprint: `@unifiedcommerce/db`

```typescript
// packages/db/src/index.ts

// ─── UC Abstractions ──────────────────────────────────────────────
export { defineTable } from "./define-table";
export { column } from "./column";

// ─── Drizzle Query Operators (re-exported) ────────────────────────
export {
  eq, ne, gt, gte, lt, lte,
  and, or, not,
  like, ilike,
  inArray, notInArray,
  between, notBetween,
  isNull, isNotNull,
  exists, notExists,
  sql,
  asc, desc,
  count, sum, avg, min, max,
  countDistinct, sumDistinct, avgDistinct,
} from "drizzle-orm";

export { alias } from "drizzle-orm/pg-core";
```

The developer's single import:

```typescript
import { defineTable, column, eq, and, desc } from "@unifiedcommerce/db";
```

Instead of today's:

```typescript
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { eq, and, desc } from "drizzle-orm";
import { organization } from "@unifiedcommerce/core/auth/auth-schema";
```

### 2.3 `defineTable` -- Astro-Style Table Definition

`defineTable` wraps Drizzle's `pgTable` with auto-injected fields. The developer writes a minimal config; `defineTable` produces a full Drizzle table with `id`, `organizationId`, `createdAt`, `updatedAt`, indexes, and composite unique constraints.

#### 2.3.1 Pseudocode: defineTable

```
Pseudocode: defineTable

FUNCTION defineTable(name, columns, extraConfig?):
  // 1. Map column configs to Drizzle column builders
  drizzleColumns = {}
  uniqueColumns = []

  FOR EACH (colName, colDef) IN columns:
    drizzleCol = mapColumnToDrizzle(colName, colDef)

    IF colDef.unique:
      uniqueColumns.PUSH(colName)
      // Remove .unique() from individual column -- will become composite
      drizzleCol = drizzleCol WITHOUT .unique()

    drizzleColumns[colName] = drizzleCol

  // 2. Check if any column references a table that has organizationId
  hasOrgScopedParent = FALSE
  FOR EACH (colName, colDef) IN columns:
    IF colDef.references AND colDef.references.table HAS organizationId:
      hasOrgScopedParent = TRUE
      BREAK

  // 3. Auto-inject fields based on whether this is a top-level or child table
  IF NOT hasOrgScopedParent:
    // Top-level entity: inject organizationId
    injectedColumns = {
      id: uuid("id").defaultRandom().primaryKey(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => organization.id, { onDelete: "cascade" }),
      ...drizzleColumns,
      createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    }
  ELSE:
    // Child table: no organizationId, just id + timestamps
    injectedColumns = {
      id: uuid("id").defaultRandom().primaryKey(),
      ...drizzleColumns,
      createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    }

  // 4. Build indexes and composite unique constraints
  FUNCTION indexBuilder(table):
    indexes = {}

    IF NOT hasOrgScopedParent:
      indexes.orgIdx = index("idx_" + name + "_org").on(table.organizationId)

      // Convert unique columns to composite unique (orgId, column)
      FOR EACH colName IN uniqueColumns:
        indexes[colName + "Unique"] = uniqueIndex(name + "_org_" + colName + "_unique")
          .on(table.organizationId, table[colName])

    // Merge any extra config from the developer
    IF extraConfig:
      indexes = { ...indexes, ...extraConfig(table) }

    RETURN indexes

  // 5. Mark table with metadata for the scoped DB proxy
  result = pgTable(name, injectedColumns, indexBuilder)
  result.__ucOrgScoped = NOT hasOrgScopedParent
  RETURN result
```

#### 2.3.2 Blueprint: defineTable Implementation

```typescript
// packages/db/src/define-table.ts

import {
  pgTable, uuid, text, timestamp, index, uniqueIndex,
  type PgTableWithColumns, type PgColumnBuilderBase,
} from "drizzle-orm/pg-core";
import { organization } from "@unifiedcommerce/core/auth/auth-schema";
import { mapColumns, extractUniqueColumns, hasOrgScopedReference } from "./column";

export function defineTable<
  TColumns extends Record<string, PgColumnBuilderBase>,
>(
  name: string,
  columnDefs: Record<string, ColumnDef>,
  extraConfig?: (table: Record<string, unknown>) => Record<string, unknown>,
) {
  const { drizzleColumns, uniqueColumnNames } = mapColumns(columnDefs);
  const isChild = hasOrgScopedReference(columnDefs);

  const allColumns = isChild
    ? {
        id: uuid("id").defaultRandom().primaryKey(),
        ...drizzleColumns,
        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
      }
    : {
        id: uuid("id").defaultRandom().primaryKey(),
        organizationId: text("organization_id")
          .notNull()
          .references(() => organization.id, { onDelete: "cascade" }),
        ...drizzleColumns,
        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
      };

  const table = pgTable(name, allColumns, (t) => {
    const indexes: Record<string, unknown> = {};

    if (!isChild) {
      indexes.orgIdx = index(`idx_${name}_org`).on(t.organizationId);
      for (const col of uniqueColumnNames) {
        indexes[`${col}Unique`] = uniqueIndex(`${name}_org_${col}_unique`)
          .on(t.organizationId, t[col]);
      }
    }

    if (extraConfig) Object.assign(indexes, extraConfig(t));
    return indexes;
  });

  // Mark for scoped DB proxy detection
  (table as Record<string, unknown>).__ucOrgScoped = !isChild;
  return table;
}
```

#### 2.3.3 What the Plugin Developer Writes

```typescript
// packages/plugins/plugin-gift-cards/src/schema.ts
import { defineTable, column } from "@unifiedcommerce/db";

// Top-level entity -- defineTable detects no parent FK,
// auto-injects: id, organizationId, createdAt, updatedAt, org index, composite unique
export const giftCards = defineTable("gift_cards", {
  code: column.text({ unique: true }),
  initialAmount: column.integer(),
  balance: column.integer(),
  currency: column.text(),
  status: column.text({ enum: ["active", "disabled", "exhausted"], default: "active" }),
  purchaserId: column.text({ optional: true }),
  recipientEmail: column.text({ optional: true }),
  senderName: column.text({ optional: true }),
  personalMessage: column.text({ optional: true }),
  sourceOrderId: column.text({ optional: true }),
  expiresAt: column.timestamp({ optional: true }),
  version: column.integer({ default: 0 }),
  metadata: column.json({ default: {} }),
});

// Child table -- defineTable detects FK to giftCards (which has organizationId),
// auto-injects: id, createdAt. No organizationId.
export const giftCardTransactions = defineTable("gift_card_transactions", {
  giftCardId: column.uuid({ references: giftCards }),
  type: column.text({ enum: ["debit", "credit", "refund"] }),
  amount: column.integer(),
  balanceAfter: column.integer(),
  orderId: column.text({ optional: true }),
  note: column.text({ optional: true }),
});
```

**What the developer did NOT write:**
- `id` column (auto-injected)
- `organizationId` column (auto-injected on top-level tables)
- `createdAt` / `updatedAt` timestamps (auto-injected)
- `organization` FK reference and `ON DELETE CASCADE` (auto-injected)
- `idx_gift_cards_org` index (auto-injected)
- Composite unique `(organizationId, code)` (auto-converted from `unique: true`)

### 2.4 `column` Namespace

The `column` namespace provides type-safe column builders that `defineTable` converts to Drizzle column builders.

```typescript
// packages/db/src/column.ts

export const column = {
  text: (opts?: { unique?: boolean; optional?: boolean; enum?: readonly string[]; default?: string }) => ({ type: "text" as const, ...opts }),
  integer: (opts?: { unique?: boolean; optional?: boolean; default?: number }) => ({ type: "integer" as const, ...opts }),
  boolean: (opts?: { optional?: boolean; default?: boolean }) => ({ type: "boolean" as const, ...opts }),
  uuid: (opts?: { references?: unknown; optional?: boolean }) => ({ type: "uuid" as const, ...opts }),
  timestamp: (opts?: { optional?: boolean; default?: "now" }) => ({ type: "timestamp" as const, ...opts }),
  json: (opts?: { optional?: boolean; default?: unknown }) => ({ type: "json" as const, ...opts }),
};
```

### 2.5 Scoped DB Proxy

Route handlers and plugin contexts receive a `db` instance that is **automatically scoped** to the actor's organization. All `select`, `update`, `delete` queries on org-scoped tables get `WHERE organization_id = ?` injected. All `insert` operations get `organizationId` auto-set.

#### 2.5.1 Pseudocode: Scoped DB Proxy

```
Pseudocode: createScopedDb

FUNCTION createScopedDb(rawDb, organizationId):
  RETURN new Proxy(rawDb, {
    get(target, prop):
      IF prop === "select":
        RETURN (...args) =>
          // Wrap the query builder to inject WHERE org_id = ? on .from()
          wrapSelectBuilder(target.select(...args), organizationId)

      IF prop === "insert":
        RETURN (table) =>
          // Wrap .values() to auto-set organizationId
          wrapInsertBuilder(target.insert(table), table, organizationId)

      IF prop === "update":
        RETURN (table) =>
          // Wrap .where() to inject AND org_id = ?
          wrapUpdateBuilder(target.update(table), table, organizationId)

      IF prop === "delete":
        RETURN (table) =>
          // Wrap .where() to inject AND org_id = ?
          wrapDeleteBuilder(target.delete(table), table, organizationId)

      // Pass through everything else (transaction, raw, etc.)
      RETURN target[prop]
  })


FUNCTION wrapSelectBuilder(builder, organizationId):
  originalFrom = builder.from
  builder.from = (table) =>
    IF table.__ucOrgScoped:
      RETURN originalFrom(table).where(eq(table.organizationId, organizationId))
    ELSE:
      RETURN originalFrom(table)
  RETURN builder


FUNCTION wrapInsertBuilder(builder, table, organizationId):
  IF NOT table.__ucOrgScoped:
    RETURN builder
  originalValues = builder.values
  builder.values = (data) =>
    IF Array.isArray(data):
      RETURN originalValues(data.map(row => ({ ...row, organizationId })))
    ELSE:
      RETURN originalValues({ ...data, organizationId })
  RETURN builder
```

#### 2.5.2 How Routes Provide the Scoped DB

The `router()` builder already provides `db` in the handler context. After this RFC, that `db` is automatically scoped:

```
Pseudocode: Route Handler DB Scoping

// In router.ts handler execution:
FUNCTION executeHandler(fn, honoContext):
  actor = honoContext.get("actor")
  rawDb = pluginCtx.database.db
  orgId = actor?.organizationId

  scopedDb = orgId ? createScopedDb(rawDb, orgId) : rawDb

  handlerCtx = {
    input: ...,
    actor: actor,
    db: scopedDb,   // <-- scoped to actor's org
    services: ...,
  }

  RETURN fn(handlerCtx)
```

#### 2.5.3 What the Plugin Developer Writes (Queries)

```typescript
// Plugin route handler -- ZERO org awareness:
r.get("/")
  .summary("List gift cards")
  .permission("gift-cards:admin")
  .handler(async ({ db }) => {
    // db.select().from(giftCards) automatically includes
    // WHERE organization_id = <actor's org>
    const cards = await db.select().from(giftCards);
    return cards;
  });

r.post("/")
  .summary("Create gift card")
  .permission("gift-cards:admin")
  .handler(async ({ db, input }) => {
    // db.insert(giftCards).values({...}) automatically sets
    // organizationId from actor context
    const [card] = await db.insert(giftCards).values({
      code: generateCode(),
      balance: input.amount,
      currency: input.currency,
    }).returning();
    return card;
  });
```

The developer writes normal Drizzle queries. The proxy handles scoping.

### 2.6 Boot Validation

At kernel boot, every plugin schema table is validated:

```
Pseudocode: Boot Validation

FUNCTION validatePluginSchemas(pluginSchemas):
  FOR EACH (tableName, table) IN pluginSchemas:
    hasOrgId = table HAS COLUMN "organizationId"
    hasOrgScopedParentFK = ANY column in table REFERENCES a table WITH organizationId

    IF NOT hasOrgId AND NOT hasOrgScopedParentFK:
      THROW Error:
        "Plugin table '${tableName}' has no organization scope.
         Use defineTable() from @unifiedcommerce/db instead of pgTable().
         defineTable() auto-injects organizationId for top-level tables
         and detects child tables via foreign key references."

      // Server will NOT start. Clear error, clear fix.
```

Three outcomes:
1. Used `defineTable` for top-level entity -- has `organizationId` -- **passes**
2. Used `defineTable` for child table (FK to org-scoped parent) -- no `organizationId`, inherits -- **passes**
3. Used raw `pgTable` with no org scope -- **blocked** -- server refuses to start

### 2.7 Core Schema Migration

Core tables themselves migrate from raw `pgTable` to `defineTable`. The core is its own first consumer of the abstraction:

```typescript
// BEFORE (packages/core/src/modules/catalog/schema.ts):
export const sellableEntities = pgTable("sellable_entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),
  slug: text("slug").notNull().unique(),
  // ...
});

// AFTER:
import { defineTable, column } from "@unifiedcommerce/db";

export const sellableEntities = defineTable("sellable_entities", {
  type: column.text(),
  slug: column.text({ unique: true }),
  status: column.text({ enum: ["draft", "active", "archived", "discontinued"], default: "draft" }),
  isVisible: column.boolean({ default: false }),
  metadata: column.json({ default: {} }),
  publishedAt: column.timestamp({ optional: true }),
});
```

### 2.8 Default Organization

Most starters begin as single-tenant. The `createKernel()` function auto-creates a **default organization** during boot if none exists:

```
Pseudocode: Kernel Boot

FUNCTION bootKernel(config):
  db = initDatabase(config)
  auth = createAuth(db, config)

  // Ensure default organization exists
  defaultOrg = db.SELECT FROM organization WHERE id = 'org_default'
  IF NOT defaultOrg:
    db.INSERT INTO organization (id, name, slug, createdAt)
    VALUES ('org_default', config.storeName, 'default', NOW())

  // Dev key is bound to default org
  IF config.auth.enableDevKey:
    devKeyActor.organizationId = 'org_default'

  RETURN kernel
```

### 2.9 API Key Organization Binding

API keys must be associated with an organization:

```
Pseudocode: API Key with Organization

FUNCTION verifyApiKey(key):
  keyRecord = db.SELECT FROM apikey WHERE key_hash = hash(key)
  IF NOT keyRecord: RETURN null

  RETURN {
    userId: keyRecord.userId,
    organizationId: keyRecord.metadata.organizationId,
    permissions: keyRecord.permissions,
  }
```

### 2.10 Checkout Pipeline: Organization Propagation

The checkout must verify cart org matches actor org and propagate to the order:

```
Pseudocode: Checkout Organization Flow

FUNCTION checkout(cartId, paymentMethodId, actor):
  orgId = actor.organizationId
  cart = cartService.getById(cartId)

  // Verify cart belongs to actor's org (scoped DB already handles this,
  // but explicit check prevents cross-org cart hijacking)
  IF cart.organizationId != orgId:
    THROW ValidationError("Cart does not belong to this organization")

  // Order creation automatically gets orgId via scoped DB
  order = orderService.create({ ... }, actor)
  RETURN order
```

---

## 3. Plugin Developer Experience (Complete Picture)

### 3.1 Schema Definition

```typescript
// One import. One function. Auto-injected id, orgId, timestamps, indexes.
import { defineTable, column } from "@unifiedcommerce/db";

export const giftCards = defineTable("gift_cards", {
  code: column.text({ unique: true }),
  balance: column.integer(),
  currency: column.text(),
});

export const giftCardTransactions = defineTable("gift_card_transactions", {
  giftCardId: column.uuid({ references: giftCards }),
  amount: column.integer(),
  type: column.text({ enum: ["debit", "credit", "refund"] }),
});
```

### 3.2 Queries (Routes)

```typescript
// db is scoped. Queries auto-filtered. Inserts auto-stamped.
r.get("/").handler(async ({ db }) => {
  return db.select().from(giftCards);
  // WHERE organization_id = ? injected by proxy
});

r.post("/").handler(async ({ db, input }) => {
  const [card] = await db.insert(giftCards).values({
    code: generateCode(),
    balance: input.amount,
  }).returning();
  // organizationId auto-set by proxy
  return card;
});
```

### 3.3 What the Developer NEVER Writes

| Concern | Auto-Handled By |
|---------|----------------|
| `id` column | `defineTable` |
| `organizationId` column | `defineTable` |
| `createdAt` / `updatedAt` | `defineTable` |
| FK to `organization` table | `defineTable` |
| `ON DELETE CASCADE` | `defineTable` |
| `idx_<table>_org` index | `defineTable` |
| Composite unique constraints | `defineTable` (converts `.unique()`) |
| `WHERE organization_id = ?` | Scoped DB proxy |
| `organizationId` value on insert | Scoped DB proxy |
| Importing from `drizzle-orm` | `@unifiedcommerce/db` re-exports |
| Boot validation | Kernel validates all tables at startup |

### 3.4 Forgot `defineTable`?

Server refuses to start with a clear error:

```
Error: Plugin "gift-cards" table "giftCards" has no organization scope.

  Use defineTable() from @unifiedcommerce/db instead of pgTable().
  defineTable() auto-injects organizationId for top-level tables
  and detects child tables via foreign key references.
```

---

## 4. Implementation Plan

### Phase 1: `@unifiedcommerce/db` Package (1 day)

1. Create `packages/db/` with `package.json`, `tsconfig.json`
2. Implement `defineTable` with auto-injection logic (organizationId, id, timestamps, indexes, composite uniques)
3. Implement `column` namespace (text, integer, boolean, uuid, timestamp, json)
4. Implement `hasOrgScopedReference` detection (child table auto-detection)
5. Re-export all Drizzle query operators (eq, and, desc, sql, count, etc.)
6. Add `__ucOrgScoped` metadata flag on tables

### Phase 2: Scoped DB Proxy (2 days)

1. Implement `createScopedDb(rawDb, organizationId)` proxy
2. Intercept `select().from()` to inject `WHERE organization_id = ?` on org-scoped tables
3. Intercept `insert().values()` to auto-set `organizationId`
4. Intercept `update()` and `delete()` to inject `AND organization_id = ?`
5. Pass through `transaction()`, `raw()`, and other non-query methods
6. Wire into `router()` builder so handler `db` is automatically scoped from `actor.organizationId`

### Phase 3: Core Schema Migration (1-2 days)

1. Migrate all 15 top-level core tables from `pgTable` to `defineTable`
2. Migrate all child tables to `defineTable` (they auto-detect parent FK)
3. Verify all 6 unique constraints become composite
4. Update `buildSchema()` to handle `defineTable`-produced tables

### Phase 4: Service Layer + Routes (1-2 days)

1. Update core services to use scoped DB (most changes become deletions -- remove manual org filtering)
2. Update REST routes to pass scoped `db` to services
3. Update API key verification to return `organizationId`
4. Update dev key actor with `organizationId: "org_default"`
5. Add default org creation to `createKernel()` boot

### Phase 5: Boot Validation + Tests + Plugins (2 days)

1. Implement boot-time schema validation (catch `pgTable` without org scope)
2. Update all 266+ core tests
3. Update test actors with `organizationId: "org_default"`
4. Migrate all plugin schemas to `defineTable`
5. Update seed scripts
6. Multi-org isolation test: two orgs, verify data separation

---

## 5. Verification

1. `npx tsc --noEmit` -- zero errors across core, db package, all plugins, all apps
2. `bun run test` -- all core tests pass with scoped DB
3. Plugin tests pass with `defineTable` schemas
4. Fashion starter: seed, dev, checkout all work
5. **Multi-org isolation**: create org A and org B, add products to each, verify org A cannot see org B's products via API
6. **Boot validation**: use raw `pgTable` in a plugin, verify server refuses to start with clear error
7. **Scoped DB**: verify `db.select().from(giftCards)` in a route handler only returns the actor's org's data
8. **Insert scoping**: verify `db.insert(giftCards).values({...})` auto-sets organizationId without developer specifying it

---

## 6. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Scoped DB proxy breaks on complex queries (joins, subqueries) | Test all Drizzle query patterns in the proxy. For truly complex queries, the raw unscoped `db` is available via `ctx.database.db` (escape hatch). |
| `defineTable` TypeScript types don't include auto-injected columns | `defineTable` return type explicitly includes `id`, `organizationId`, `createdAt`, `updatedAt` in the type signature. TypeScript autocomplete works. |
| Proxy performance overhead | JavaScript Proxy overhead is negligible (~nanoseconds per intercept). The real work is the SQL query itself. Benchmark to confirm. |
| Plugin developers bypass proxy via raw `pgTable` | Boot validation catches this. Server won't start. |
| `text` type for organizationId (not UUID) | Better Auth constraint. Immutable. Acceptable -- it's a FK to an external system's text PK. |
| Organization deletion cascades all data | Intentional. Add confirmation step to delete API. |
| Drizzle internal changes break the proxy | Pin Drizzle version. Test proxy against Drizzle upgrades in CI. The proxy intercepts public API methods (select, insert, update, delete), not internals. |
