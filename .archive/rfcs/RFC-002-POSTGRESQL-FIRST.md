# RFC-002: PostgreSQL-First Architecture -- Remove In-Memory Repositories, SQLite Adapter, and Plugin Ephemeral State

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-14
- **Scope:** `packages/core`, `packages/adapters/adapter-sqlite`, `packages/plugins/plugin-marketplace`, `packages/plugins/plugin-pos`
- **Depends on:** RFC-001 (implemented)
- **Estimated effort:** 3-4 days

---

## 1. Summary

The UnifiedCommerce Engine currently supports three persistence strategies: PostgreSQL (via Drizzle ORM), SQLite (via better-sqlite3), and in-memory JavaScript Maps/Arrays. The kernel at `packages/core/src/runtime/kernel.ts` dynamically selects between PostgreSQL repositories and in-memory repository doubles at boot time based on a runtime `hasRealDatabase` check. Two plugins (marketplace, POS) bypass this mechanism entirely and unconditionally store domain data in JavaScript Maps that vanish on process restart.

This RFC proposes making PostgreSQL the sole persistence backend. The in-memory repository implementations, the SQLite adapter package, the kernel's conditional repository selection logic, and the plugin in-memory state patterns will all be removed. Core tests will migrate from in-memory doubles to PGlite (an in-process WASM PostgreSQL already present in the codebase), ensuring tests exercise real SQL semantics while remaining fast and self-contained.

---

## 2. Motivation

### 2.1 In-Memory Repositories Create a False Sense of Test Coverage

The 10 in-memory repository implementations in `packages/core/src/modules/*/repository/in-memory.ts` are bespoke reimplementations of PostgreSQL query semantics using Maps and Arrays. They do not enforce foreign key constraints, do not implement `IS NULL` vs `= NULL` correctly (the root cause of the variantId bug documented in MEMORY.md), do not support `LIKE`/`ILIKE` operators, and do not enforce unique constraints at the data layer. Every behavioral difference between the in-memory double and the real PostgreSQL repository is a potential production bug that tests will not catch.

The codebase already contains `packages/core/src/test-utils/create-pglite-adapter.ts`, which provides an in-process WASM PostgreSQL (PGlite) adapter with real SQL execution, constraint enforcement, and transaction semantics. This adapter makes the in-memory repository doubles redundant.

### 2.2 SQLite Is Not Used by Any Application

Neither `apps/runvae` nor `apps/store-example` use the SQLite adapter. Both Drizzle config files (`drizzle.config.ts`) are set to `dialect: "postgresql"`. All schema definitions use `pgTable` from `drizzle-orm/pg-core`. The SQLite adapter cannot execute `pgTable`-defined schemas, making it structurally incompatible with the current schema layer. It is dead code.

### 2.3 Plugin In-Memory State Is a Production Data Loss Risk

The marketplace plugin (`packages/plugins/plugin-marketplace/src/index.ts`) and POS plugin (`packages/plugins/plugin-pos/src/index.ts`) use `createState()` patterns that store vendors, sub-orders, payouts, and POS sessions in JavaScript `Map<string, T>` instances. Both plugins define corresponding `pgTable` schema tables that are pushed to PostgreSQL but never read from or written to. A server restart, crash, container recycle, or horizontal scaling event silently destroys all marketplace and POS data.

### 2.4 Conditional Kernel Logic Is Accidental Complexity

The `hasRealDatabase` check at `kernel.ts:215-217` introduces 12 conditional branches (one per module) that double the number of code paths through the kernel initialization. Every new module added to the engine must implement both a PostgreSQL repository and an in-memory double, and the kernel must wire both. Removing this duplication halves the maintenance surface of the persistence layer.

---

## 3. Inventory of Artifacts to Remove

### 3.1 In-Memory Repository Files (10 files -- DELETE)

| File | Lines | Data It Reimplements |
|------|-------|---------------------|
| `packages/core/src/modules/cart/repository/in-memory.ts` | ~200 | Carts + line items |
| `packages/core/src/modules/catalog/repository/in-memory.ts` | ~400 | Products, attributes, categories, brands, variants, options |
| `packages/core/src/modules/customers/repository/in-memory.ts` | ~250 | Customers, addresses, groups, memberships |
| `packages/core/src/modules/fulfillment/repository/in-memory.ts` | ~200 | Fulfillments, line items, events |
| `packages/core/src/modules/inventory/repository/in-memory.ts` | ~250 | Warehouses, inventory levels, movements |
| `packages/core/src/modules/media/repository/in-memory.ts` | ~150 | Media assets, entity-media links |
| `packages/core/src/modules/orders/repository/in-memory.ts` | ~300 | Orders, line items, status history, sequence counters |
| `packages/core/src/modules/pricing/repository/in-memory.ts` | ~200 | Prices, price modifiers |
| `packages/core/src/modules/promotions/repository/in-memory.ts` | ~200 | Promotions, usage records |
| `packages/core/src/modules/webhooks/repository/in-memory.ts` | ~150 | Webhook endpoints, deliveries |

### 3.2 In-Memory Repository Factory (1 file -- DELETE)

| File | Lines | Purpose |
|------|-------|---------|
| `packages/core/src/kernel/factory/in-memory-repository-factory.ts` | ~104 | Generic `createInMemoryRepository<T>()` factory |

### 3.3 SQLite Adapter Package (1 package -- DELETE entire directory)

| Path | Contents |
|------|----------|
| `packages/adapters/adapter-sqlite/` | `package.json`, `src/index.ts`, `test/sqlite.test.ts`, config files |

Dependencies to remove from workspace: `better-sqlite3@^12.4.1`, `drizzle-orm/better-sqlite3`.

### 3.4 Kernel Conditional Logic (1 file -- MODIFY)

| File | Lines to Remove | What They Do |
|------|----------------|--------------|
| `packages/core/src/runtime/kernel.ts:14-32` | 10 `InMemory*Repository` imports | Import in-memory classes |
| `packages/core/src/runtime/kernel.ts:215-217` | `hasRealDatabase` detection | Runtime database type check |
| `packages/core/src/runtime/kernel.ts:220-222` | `pricingRepository` conditional | Ternary between PG and in-memory |
| `packages/core/src/runtime/kernel.ts:225-227` | `promotionsRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:234-236` | `customersRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:241-243` | `webhooksRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:259-261` | `inventoryRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:276-278` | `catalogRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:296-298` | `cartRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:308-310` | `ordersRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:318-320` | `fulfillmentRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:354-356` | `mediaRepository` conditional | Same |
| `packages/core/src/runtime/kernel.ts:364-366` | `auditService` conditional | Ternary between real audit and null audit |

### 3.5 Plugin In-Memory State (2 plugins -- MODIFY to use DB)

| Plugin | File | In-Memory Pattern | DB Schema Tables |
|--------|------|-------------------|-----------------|
| Marketplace | `packages/plugins/plugin-marketplace/src/index.ts` | `MarketplaceState` with 4 Maps/Arrays (lines 57-75) | `marketplace_vendors`, `marketplace_vendor_entities`, `marketplace_vendor_sub_orders`, `marketplace_vendor_payouts` |
| POS | `packages/plugins/plugin-pos/src/index.ts` | `POSState` with 1 Map (lines 30-32) | `pos_sessions` |

---

## 4. Proposed Changes

### 4.1 Kernel: Remove Conditional Logic, Always Use PostgreSQL Repositories

#### Pseudocode

```
function createKernel(config):
    database = createDatabaseConnection(config)

    // REMOVED: hasRealDatabase check
    // REMOVED: all InMemory*Repository imports and ternary branches

    // Always instantiate PostgreSQL-backed Drizzle repositories
    pricingRepository    = new PricingRepository(database.db)
    promotionsRepository = new PromotionsRepository(database.db)
    customersRepository  = new CustomersRepository(database.db)
    webhooksRepository   = new WebhooksRepository(database.db)
    inventoryRepository  = new InventoryRepository(database.db)
    catalogRepository    = new CatalogRepository(database.db)
    cartRepository       = new CartRepository(database.db)
    ordersRepository     = new OrdersRepository(database.db)
    fulfillmentRepository = new FulfillmentRepository(database.db)
    mediaRepository      = new MediaRepository(database.db)

    auditService = createAuditService(database.db)

    // ... wire services with repositories (unchanged)
```

#### Code Blueprint

```typescript
// packages/core/src/runtime/kernel.ts -- IMPORTS SECTION
// DELETE lines 14-32 (all InMemory*Repository imports)
// KEEP lines 12-13 (CatalogServiceImpl, CatalogRepository)
// KEEP lines 15 (InventoryRepository), 17 (CartRepository), etc. -- the REAL repos

// DELETE lines 50-53 (createNullAuditService import)
// KEEP createAuditService import

// KERNEL BODY -- Replace lines 214-366 with:

// PostgreSQL-first: Always use Drizzle repositories (requires databaseAdapter in config)
const db = database.db as DrizzleDatabase;

const pricingRepository = new PricingRepository(db);
const promotionsRepository = new PromotionsRepository(db);
const customersRepository = new CustomersRepository(db);
const webhooksRepository = new WebhooksRepository(db);
const inventoryRepository = new InventoryRepository(db);
const catalogRepository = new CatalogRepository(db);
const cartRepository = new CartRepository(db);
const ordersRepository = new OrdersRepository(db);
const fulfillmentRepository = new FulfillmentRepository(db);
const mediaRepository = new MediaRepository(db);

// ... all service wiring remains the same, but remove `as XRepository` casts
// since we no longer union with in-memory types

services.audit = createAuditService(db);
```

The `createNullAuditService` function and its import should also be deleted. If a caller needs a no-op audit service for testing, they should use PGlite which supports real audit writes.

### 4.2 Marketplace Plugin: Migrate from Maps to Drizzle Queries

#### Pseudocode

```
// BEFORE: In-memory state
state.vendors.set(id, vendor)    -->  db.insert(vendors).values(vendor)
state.vendors.get(id)            -->  db.select().from(vendors).where(eq(vendors.id, id))
state.vendorEntities.push(link)  -->  db.insert(vendorEntities).values(link)
state.subOrders.push(subOrder)   -->  db.insert(vendorSubOrders).values(subOrder)
state.payouts.push(payout)       -->  db.insert(vendorPayouts).values(payout)
```

#### Code Blueprint

The plugin currently receives `PluginContext` which contains `database`. The Drizzle instance is at `ctx.database.db`. The pattern is identical to the influencer plugin in `apps/runvae/src/plugins/influencer-plugin.ts`:

```typescript
// packages/plugins/plugin-marketplace/src/index.ts -- PROPOSED STRUCTURE

import { eq, and, sql } from "drizzle-orm";
import { vendors, vendorEntities, vendorSubOrders, vendorPayouts } from "./schema";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

function drizzle(db: unknown): PostgresJsDatabase<Record<string, unknown>> {
  return db as PostgresJsDatabase<Record<string, unknown>>;
}

// REMOVE: MarketplaceState interface
// REMOVE: createState() function
// REMOVE: getVendorForEntity() that reads from state

function buildRoutes(ctx: PluginContext, options: MarketplacePluginOptions): PluginRouteRegistration[] {
  const { database } = ctx;

  return [
    // GET /api/marketplace/vendors
    {
      method: "GET",
      path: "/api/marketplace/vendors",
      async handler(c: any) {
        const db = drizzle(database.db);
        const rows = await db.select().from(vendors);
        return c.json({ data: rows });
      },
    },

    // GET /api/marketplace/vendors/:vendorId
    {
      method: "GET",
      path: "/api/marketplace/vendors/:vendorId",
      async handler(c: any) {
        const db = drizzle(database.db);
        const [vendor] = await db
          .select()
          .from(vendors)
          .where(eq(vendors.id, c.req.param("vendorId")));
        if (!vendor) return c.json({ error: "Vendor not found" }, 404);
        return c.json({ data: vendor });
      },
    },

    // POST /api/marketplace/vendors
    {
      method: "POST",
      path: "/api/marketplace/vendors",
      async handler(c: any) {
        const body = await c.req.json();
        const db = drizzle(database.db);
        const [vendor] = await db
          .insert(vendors)
          .values({
            name: body.name,
            email: body.email ?? null,
            status: "pending",
            commissionRateBps: body.commissionRateBps ?? options.defaultCommissionRateBps ?? 1000,
            metadata: body.metadata ?? {},
          })
          .returning();
        return c.json({ data: vendor }, 201);
      },
    },

    // PATCH /api/marketplace/vendors/:vendorId
    {
      method: "PATCH",
      path: "/api/marketplace/vendors/:vendorId",
      async handler(c: any) {
        const db = drizzle(database.db);
        const body = await c.req.json();
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (body.name != null) updates.name = body.name;
        if (body.status != null) updates.status = body.status;
        if (body.commissionRateBps != null) updates.commissionRateBps = body.commissionRateBps;

        const [updated] = await db
          .update(vendors)
          .set(updates)
          .where(eq(vendors.id, c.req.param("vendorId")))
          .returning();
        if (!updated) return c.json({ error: "Vendor not found" }, 404);
        return c.json({ data: updated });
      },
    },

    // POST /api/marketplace/vendors/:vendorId/approve
    {
      method: "POST",
      path: "/api/marketplace/vendors/:vendorId/approve",
      async handler(c: any) {
        const db = drizzle(database.db);
        const [updated] = await db
          .update(vendors)
          .set({ status: "approved", updatedAt: new Date() })
          .where(eq(vendors.id, c.req.param("vendorId")))
          .returning();
        if (!updated) return c.json({ error: "Vendor not found" }, 404);
        return c.json({ data: updated });
      },
    },

    // ... sub-orders and payouts routes follow the same pattern
  ];
}

// Hooks also change from state.vendorEntities.push(...) to db.insert(vendorEntities).values(...)
function buildHooks(ctx: PluginContext, options: MarketplacePluginOptions): PluginHookRegistration[] {
  const { database } = ctx;

  return [
    {
      key: "catalog.afterCreate",
      async handler(args: unknown) {
        const { result } = args as { result: { id: string; metadata?: Record<string, unknown> | null } };
        const vendorId = result?.metadata?.vendorId;
        if (!vendorId) return;

        const db = drizzle(database.db);
        await db.insert(vendorEntities).values({
          vendorId: String(vendorId),
          entityId: result.id,
        });
      },
    },

    {
      key: "orders.afterCreate",
      async handler(args: unknown) {
        const { result, context: hookContext } = args as { ... };
        const db = drizzle(database.db);

        // Look up vendor for each line item via DB
        for (const lineItem of result.lineItems ?? []) {
          const [link] = await db
            .select()
            .from(vendorEntities)
            .where(eq(vendorEntities.entityId, lineItem.entityId));
          if (!link) continue;

          const [vendor] = await db
            .select()
            .from(vendors)
            .where(eq(vendors.id, link.vendorId));
          if (!vendor) continue;

          // ... calculate commission, insert sub-order and payout (same math, DB writes instead of array pushes)
        }
      },
    },
    // ... remaining hooks follow same pattern
  ];
}

// Plugin factory -- REMOVE state, pass ctx to buildRoutes/buildHooks
export function marketplacePlugin(options: MarketplacePluginOptions = {}) {
  return defineCommercePlugin({
    id: "marketplace",
    version: "1.0.0",
    schema: () => ({ vendors, vendorEntities, vendorSubOrders, vendorPayouts }),
    hooks: (ctx) => buildHooks(ctx, options),     // ctx instead of state
    routes: (ctx) => buildRoutes(ctx, options),    // ctx instead of state
    mcpTools: (ctx) => buildMCPTools(ctx),         // ctx instead of state
  });
}
```

### 4.3 POS Plugin: Migrate Sessions from Map to Drizzle Queries

#### Pseudocode

```
// BEFORE:
state.sessions.set(session.id, session)     -->  db.insert(posSessions).values(session)
state.sessions.get(id)                       -->  db.select().from(posSessions).where(eq(posSessions.id, id))
state.sessions.delete(id)                    -->  db.delete(posSessions).where(eq(posSessions.id, id))
```

#### Code Blueprint

The POS plugin follows the same refactoring pattern as the marketplace plugin. The `posSessions` table already exists in the schema. The `POSState` interface and the `sessions: new Map()` initialization should be replaced with Drizzle queries against `posSessions` using the `ctx.database.db` reference from the `PluginContext`.

The tenders array (stored in `POSSession.tenders`) should be stored in the `metadata` JSONB column of `pos_sessions`, or a new `pos_tenders` table should be created if querying individual tenders is needed.

### 4.4 Core Tests: Migrate to PGlite

#### Current State

The test utility at `packages/core/src/test-utils/create-test-config.ts` creates a config without a `databaseAdapter`, causing `createKernel` to hit the `hasRealDatabase = false` branch and instantiate in-memory repositories. After removing the in-memory repositories, tests must provide a real database adapter.

The codebase already contains `createPGliteTestConfig()` (line 169 of `create-test-config.ts`) and `createPGliteTestAdapter()` (in `create-pglite-adapter.ts`), which spin up an in-process WASM PostgreSQL instance with the full schema pushed via migration SQL files. This is the correct replacement.

#### Pseudocode

```
// BEFORE (create-test-config.ts):
export async function createTestConfig(overrides):
    return defineConfig({
        database: { provider: "postgresql" },
        // NO databaseAdapter --> kernel falls back to in-memory
        ...overrides
    })

// AFTER:
export async function createTestConfig(overrides):
    if no overrides.databaseAdapter:
        adapter = await createPGliteTestAdapter()
        overrides.databaseAdapter = adapter.adapter

    return defineConfig({
        database: { provider: "postgresql" },
        databaseAdapter: overrides.databaseAdapter,
        ...overrides
    })
```

#### Code Blueprint

```typescript
// packages/core/src/test-utils/create-test-config.ts -- MODIFIED

export async function createTestConfig(
  overrides: Partial<CommerceConfig> = {},
): Promise<CommerceConfig> {
  // If no database adapter provided, use PGlite for real PostgreSQL semantics
  if (!overrides.databaseAdapter) {
    const { createPGliteTestAdapter } = await import("./create-pglite-adapter");
    const { adapter } = await createPGliteTestAdapter();
    overrides.databaseAdapter = adapter;
  }

  return defineConfig({
    version: "0.0.1-test",
    storeName: "Test Store",
    database: { provider: "postgresql" },
    // ... rest of config unchanged ...
    ...overrides,
  });
}
```

This change is backward-compatible: tests that already pass `databaseAdapter` (e.g., via `createPGliteTestConfig()`) continue to work unchanged. Tests that relied on in-memory behavior will now execute against PGlite, which may surface previously hidden bugs (a desirable outcome).

### 4.5 Delete SQLite Adapter Package

```
rm -rf packages/adapters/adapter-sqlite/
```

Remove any workspace references in the root `package.json` or `turbo.json` that reference `adapter-sqlite`. Remove any `@unifiedcommerce/adapter-sqlite` imports across the codebase (there should be none, since no application uses it).

### 4.6 Config Type: Constrain Database Provider

#### Code Blueprint

```typescript
// packages/core/src/config/types.ts -- line 160

database: {
  provider: "postgresql";    // Changed from `string` to literal type
  options?: Record<string, unknown>;
};
```

This change causes a compile-time error for any config that specifies `provider: "sqlite"` or any other value, making the PostgreSQL-first policy enforceable at the type level.

---

## 5. Files Changed -- Complete Manifest

### DELETE (12 files + 1 directory)

| Path | Reason |
|------|--------|
| `packages/core/src/modules/cart/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/catalog/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/customers/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/fulfillment/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/inventory/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/media/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/orders/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/pricing/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/promotions/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/modules/webhooks/repository/in-memory.ts` | In-memory repository |
| `packages/core/src/kernel/factory/in-memory-repository-factory.ts` | Generic factory |
| `packages/adapters/adapter-sqlite/` | Entire SQLite adapter package |

### MODIFY (6 files)

| Path | Change |
|------|--------|
| `packages/core/src/runtime/kernel.ts` | Remove `hasRealDatabase`, all InMemory imports, conditional branches |
| `packages/core/src/config/types.ts` | Constrain `provider` to `"postgresql"` literal |
| `packages/core/src/test-utils/create-test-config.ts` | Auto-provision PGlite when no adapter provided |
| `packages/plugins/plugin-marketplace/src/index.ts` | Replace `MarketplaceState` Maps with Drizzle queries |
| `packages/plugins/plugin-pos/src/index.ts` | Replace `POSState` Map with Drizzle queries |
| `packages/core/src/index.ts` | Remove any re-exports of in-memory factories |

### VERIFY (26 test files)

All test files under `packages/core/test/` must be run after the migration to confirm they pass against PGlite. Tests that directly import `InMemoryWebhooksRepository` or other in-memory classes will fail at compile time and must be updated to use `createTestKernel()` or `createPGliteTestAdapter()`.

---

## 6. Migration Strategy

### Phase 1: Delete Dead Code (Low Risk)

1. Delete the SQLite adapter package (`packages/adapters/adapter-sqlite/`)
2. Delete the in-memory repository factory (`packages/core/src/kernel/factory/in-memory-repository-factory.ts`)
3. Remove re-exports from `packages/core/src/index.ts` if any
4. Constrain `database.provider` type to `"postgresql"`

These changes affect no runtime behavior since nothing imports these artifacts in production code paths.

### Phase 2: Kernel Simplification (Medium Risk)

1. Remove all `InMemory*Repository` imports from `kernel.ts` (lines 14-32)
2. Remove `hasRealDatabase` check (lines 215-217)
3. Replace 12 conditional repository instantiations with direct PostgreSQL repository constructors
4. Replace `createNullAuditService()` with `createAuditService(db)` unconditionally
5. Update `createTestConfig()` to auto-provision PGlite

**Risk mitigation:** Run the full core test suite (`packages/core/test/`) after this change. Tests will either pass (PGlite works correctly) or surface hidden bugs that the in-memory doubles were masking.

### Phase 3: Plugin Persistence (Medium Risk)

1. Refactor marketplace plugin routes and hooks from Map/Array to Drizzle queries
2. Refactor POS plugin session management from Map to Drizzle queries
3. Remove `createState()`, `MarketplaceState`, `POSState` interfaces
4. Run Runvae integration tests (233 tests in `apps/runvae/test/`)

**Risk mitigation:** The marketplace plugin's schema tables already exist in PostgreSQL. The data model is identical between the in-memory interfaces and the Drizzle schema. The refactoring is mechanical: replace `state.x.set(id, obj)` with `db.insert(table).values(obj)` and `state.x.get(id)` with `db.select().from(table).where(eq(table.id, id))`.

### Phase 4: Delete In-Memory Repositories (Low Risk after Phase 2)

1. Delete all 10 `in-memory.ts` files
2. Fix any remaining compilation errors (test files that import in-memory classes directly)

This phase is safe only after Phase 2 confirms no runtime code depends on the in-memory repositories.

---

## 7. Impact on Existing Applications

### apps/runvae

No changes required. Runvae already uses `postgresAdapter()` exclusively. The marketplace plugin refactoring (Phase 3) will make vendor data survive server restarts, which is a net improvement.

### apps/store-example

No changes required. Already uses `postgresAdapter()`.

### Core Test Suite

Tests will migrate from synthetic in-memory behavior to real PostgreSQL semantics via PGlite. This may surface latent bugs that were hidden by the behavioral gap between in-memory doubles and real SQL. Each failure is a bug fix opportunity, not a regression.

---

## 8. What This RFC Does NOT Do

- **Remove PGlite:** PGlite is an in-process WASM PostgreSQL, not an "in-memory database" in the same sense as the JavaScript Map-based repositories. It executes real SQL, enforces constraints, and supports transactions. It is the correct test backend.
- **Remove the in-memory storage adapter for tests:** The `createInMemoryStorageAdapter()` in `create-test-config.ts` is a file storage mock (S3/R2 substitute), not a database persistence mock. It remains useful for tests that do not need a real filesystem.
- **Remove the generic `createInMemoryRepository` if used by external consumers:** If any downstream consumer depends on this factory, it should be moved to a `@unifiedcommerce/test-utils` package rather than deleted. Current analysis shows no external usage.

---

## 9. Verification Criteria

The migration is considered complete when:

1. `grep -r "InMemory" packages/core/src/ --include="*.ts"` returns zero results
2. `grep -r "hasRealDatabase" packages/core/src/ --include="*.ts"` returns zero results
3. `grep -r "createState\|new Map<string" packages/plugins/ --include="*.ts"` returns zero results (for domain data)
4. `ls packages/adapters/adapter-sqlite/` returns "No such file or directory"
5. `bun run test` in `packages/core/` passes all tests against PGlite
6. `bun run test` in `apps/runvae/` passes all 233 integration tests
7. Marketplace vendors persist across server restarts (manual verification)
8. `psql runvae -c "SELECT COUNT(*) FROM marketplace_vendors"` returns non-zero after vendor registration
