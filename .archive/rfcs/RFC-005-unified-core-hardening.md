# RFC-005: Unified Core Hardening

**Status**: Draft
**Author**: Engineering
**Created**: March 2026
**Supersedes**: RFC-003 (Medusa Learnings), RFC-004 (PayloadCMS Learnings)

---

## Table of Contents

1. [Summary](#1-summary)
2. [Design Principles](#2-design-principles)
3. [Part 1 -- Compensation Chains](#3-part-1----compensation-chains)
4. [Part 2 -- Inventory Concurrency Safety](#4-part-2----inventory-concurrency-safety)
5. [Part 3 -- Repository Factory](#5-part-3----repository-factory)
6. [Part 4 -- Access Composition](#6-part-4----access-composition)
7. [Part 5 -- Request Context and Hook Enrichment](#7-part-5----request-context-and-hook-enrichment)
8. [Part 6 -- Database-Backed Job Queue](#8-part-6----database-backed-job-queue)
9. [Part 7 -- Local API](#9-part-7----local-api)
10. [Part 8 -- Audit Log](#10-part-8----audit-log)
11. [Part 9 -- Plugin Config Transformation and Schema Extension](#11-part-9----plugin-config-transformation-and-schema-extension)
12. [Part 10 -- Injectable Matchers and Adapter Self-Description](#12-part-10----injectable-matchers-and-adapter-self-description)
13. [Part 11 -- Guest Cart](#13-part-11----guest-cart)
14. [Part 12 -- Query Composition Layer](#14-part-12----query-composition-layer)
15. [Part 13 -- Type Augmentation](#15-part-13----type-augmentation)
16. [Adoption Path](#16-adoption-path)
17. [What We Keep As-Is](#17-what-we-keep-as-is)

---

## 1. Summary

This RFC is the definitive engineering plan for hardening the @unifiedcommerce/core engine. It consolidates everything learned from deep source reading of Medusa v2 (RFC-003) and PayloadCMS v3 (RFC-004) into a single, ordered, implementable document.

The engine already has strong foundations: a clean Hono HTTP layer, Drizzle ORM with proper null handling, Better Auth integration, a three-tier hook system (BeforeHook/AfterHook), an adapter pattern for payments/storage/tax/search, `Result<T, E>` error handling, in-memory repositories for testing, MCP tools, and a working order state machine. These foundations are not changing.

What this RFC adds is the missing connective tissue that separates a working prototype from a production-grade commerce engine. These are the thirteen changes, in the order they should be built:

1. **Compensation Chains** -- Rollback logic for multi-step operations like checkout. Synchronous, in-request, no external state.
2. **Inventory Concurrency Safety** -- `SELECT FOR UPDATE` locking and a `version` column to prevent inventory oversell under concurrent load.
3. **Repository Factory** -- A `createRepository(table, db)` function that derives typed CRUD from Drizzle schemas, eliminating 2000+ lines of structural repetition.
4. **Access Composition** -- `accessOR`, `accessAND`, `conditional` utility functions that compose access rules and support query-level filtering via `WhereClause` return values.
5. **Request Context and Hook Enrichment** -- Rename `metadata` to `context`, add `requestId`, `origin`, and `jobs` to `HookContext`.
6. **Database-Backed Job Queue** -- A `DrizzleJobsAdapter` that stores jobs in the application database. Zero external dependencies. Serverless-compatible.
7. **Local API** -- A hook-aware internal API so that code calling `localApi.orders.create()` fires the full hook pipeline within the same transaction.
8. **Audit Log** -- A `commerce_audit_log` table that records state transitions with actor, timestamp, and payload. Every state machine transition writes an entry automatically.
9. **Plugin Config Transformation and Schema Extension** -- Plugins become config transform functions. Core modules accept `extraColumns` for schema extension without forking.
10. **Injectable Matchers and Adapter Self-Description** -- `CartItemMatcher` for configurable cart deduplication. `PaymentAdapter.extraColumns()` for adapter-owned schema columns.
11. **Guest Cart** -- Anonymous cart creation with a `secret` token and `mergeCarts()` for post-login consolidation.
12. **Query Composition Layer** -- A `kernel.query({ entity, include, filters })` API that resolves related entities in batched database queries, eliminating manual multi-service assembly.
13. **Type Augmentation** -- A `CommerceModuleTypes` interface map that plugins can augment via TypeScript module augmentation.

Every part includes: the problem it solves referencing current code, pseudo-code for the algorithm, and a TypeScript blueprint ready for implementation. No part requires an external service, a new runtime dependency, or a change to the deployment model.

---

## 2. Design Principles

Before any code: these are the non-negotiable constraints that shaped every decision in this document. They come directly from the engine's five ethos pillars.

**Developer Experience Above All.** If a pattern requires the developer to learn a new concept, there must be a proportional reduction in the code they need to write. If a pattern saves core maintainers time but makes plugin authors think harder, it fails this test. The `createRepository` factory is a direct expression of this: it eliminates 200 lines of code per module and requires zero new concepts -- just call the function.

**Serverless-First (Not Serverless-Only).** Every design must work correctly in an environment where each HTTP request is an isolated function invocation with no shared memory across requests. This rules out in-process event buses, in-memory caches that assume persistence, and any pattern that relies on a long-running background process that "just exists." The job queue, for example, is triggered by an HTTP endpoint, not a polling daemon.

**Zero Vendor Lock-In.** No pattern in this document requires Redis, RabbitMQ, AWS SQS, or any external infrastructure beyond a PostgreSQL database. Where external infrastructure is useful (like a dedicated queue service for high-throughput workloads), it is supported through the adapter pattern, but never required.

**Composition Over Configuration.** Access control is composable functions, not YAML permission maps. Plugins are config transforms, not manifest registrations. Cart matching is an injectable function, not a config flag. The engine should feel like a library you compose with, not a framework you configure.

**One Extension Primitive.** The hook system is the primary extension mechanism. Background jobs, audit logging, access control -- all of these integrate through hooks. There is not a separate extension API for each concern.

---

## 3. Part 1 -- Compensation Chains

### 3.1 The problem

Read `packages/core/src/hooks/checkout.ts`. The checkout flow runs BeforeHooks for validation and data enrichment, then AfterHooks for side effects. The AfterHooks include `capturePayment` and `reserveInventory`. These run sequentially with no compensation link between them.

The failure path:

```
BeforeHooks: validate cart, resolve prices, calculate tax, authorize payment -- all succeed
order.create() -- succeeds, order row written to DB
AfterHooks run in sequence:
  capturePayment()     -- charges the customer's card, succeeds
  reserveInventory()   -- FAILS (DB error, warehouse unreachable, anything)
```

The customer has been charged. An order exists. Inventory has not been reserved. The system is inconsistent and there is no automated recovery path.

This is not theoretical. Payment processors respond in milliseconds. Inventory reservation involves a database write. Any transient fault between those two operations produces this outcome.

### 3.2 What a compensation chain is

A compensation chain is a list of steps. Each step has a `run` function and an optional `compensate` function. The executor runs steps in order. If a step fails, all previously completed steps are compensated in reverse order. The compensate function receives the value that its corresponding `run` function returned, so it has everything it needs to undo the work.

This is not a saga. It is not a workflow engine. It does not persist state across requests. It does not integrate with AWS Step Functions. It runs entirely within a single HTTP request. It is approximately 60 lines of TypeScript.

### 3.3 Pseudo-code

```
define a Step as:
  id: string (for logging)
  run: (input, context) -> Result<output>
  compensate?: (output, context) -> void

to execute a compensation chain:
  create an empty stack of completed steps
  for each step in the list:
    call step.run(current-input, context)
    if run returns an error:
      for each completed step in the stack, in REVERSE order:
        call step.compensate(the value run returned for that step, context)
        if compensate throws, log it but do NOT override the original error
      return the original error
    else:
      push { step, output } onto the stack
  return success with the final input
```

The compensate functions are best-effort. If compensation itself fails (for example, a refund API is unreachable), the failure is logged at error level with a flag for manual review. The original error is returned to the caller. This is the correct behavior: a failed compensation is a separate operational concern, not something that should mask the root cause.

### 3.4 Blueprint

```typescript
// packages/core/src/kernel/compensation/types.ts

import type { TxContext } from "../database/tx-context"
import type { HookContext } from "../hooks/types"
import type { Result } from "../result"

/**
 * CompensationContext carries the transaction and hook context into
 * both the run and compensate functions. Steps have access to services,
 * the actor, and the logger through ctx.hook.
 */
export interface CompensationContext {
  tx: TxContext | null
  hook: HookContext
}

/**
 * A Step is one unit of work in a compensation chain.
 *
 * TInput is the data the step receives (typically the shared checkout data object).
 * TOutput is what the step produces. This same value is passed to compensate()
 * so the compensate function has everything it needs to reverse the work.
 */
export interface Step<TInput, TOutput> {
  id: string
  run: (input: TInput, ctx: CompensationContext) => Promise<Result<TOutput>>
  compensate?: (output: TOutput, ctx: CompensationContext) => Promise<void>
}
```

```typescript
// packages/core/src/kernel/compensation/executor.ts

import type { CompensationContext, Step } from "./types"
import type { Result } from "../result"

/**
 * Runs a list of steps in order. If any step fails, compensates all
 * previously completed steps in reverse. Steps share the same input
 * object (they may mutate it to enrich downstream steps, following
 * the same pattern established by BeforeHooks).
 *
 * Compensation failures are logged but do not override the original error.
 */
export async function runCompensationChain<TInput>(
  steps: Array<Step<TInput, unknown>>,
  input: TInput,
  ctx: CompensationContext,
): Promise<Result<TInput>> {
  const completed: Array<{ step: Step<TInput, unknown>; output: unknown }> = []

  for (const step of steps) {
    const result = await step.run(input, ctx)

    if (!result.ok) {
      ctx.hook.logger.error(
        `Compensation chain failed at step "${step.id}". ` +
        `Running ${completed.length} compensation(s).`,
        { error: result.error },
      )

      for (const done of [...completed].reverse()) {
        if (!done.step.compensate) continue
        try {
          await done.step.compensate(done.output, ctx)
          ctx.hook.logger.info(`Compensated step "${done.step.id}"`)
        } catch (compensateError) {
          ctx.hook.logger.error(
            `Compensation for step "${done.step.id}" failed. Manual review required.`,
            { compensateError },
          )
        }
      }

      return result
    }

    completed.push({ step, output: result.value })
  }

  return { ok: true, value: input }
}
```

### 3.5 Checkout rewrite

The current separate AfterHooks for `capturePayment` and `reserveInventory` are replaced by a single AfterHook that runs a compensation chain. The read-side BeforeHooks (validate cart, resolve prices, calculate tax, calculate shipping) remain unchanged because they only read data and enrich the CheckoutData object -- they do not need compensation.

```typescript
// packages/core/src/hooks/checkout-completion.ts

import type { Step } from "../kernel/compensation/types"
import type { CheckoutData } from "./checkout"
import { Ok, Err } from "../kernel/result"
import { CommerceValidationError } from "../kernel/errors"

/**
 * Step 1: Reserve inventory.
 *
 * Output: the list of reservations created.
 * Compensate: release each reservation.
 *
 * Inventory reservation runs BEFORE payment capture. This is deliberate:
 * if stock is unavailable, we should find out before charging the customer.
 * The compensation for this step releases the reserved quantities.
 */
export const reserveInventoryStep: Step<
  CheckoutData,
  Array<{ entityId: string; variantId: string | null; quantity: number; orderId: string }>
> = {
  id: "reserve-inventory",

  async run(data, ctx) {
    const inventory = ctx.hook.services.inventory
    const reservations: Array<{
      entityId: string; variantId: string | null; quantity: number; orderId: string
    }> = []

    for (const item of data.lineItems) {
      const result = await inventory.reserve({
        entityId: item.entityId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        orderId: data.checkoutId,
        performedBy: ctx.hook.actor?.userId ?? "system",
      })

      if (!result.ok) {
        return Err(new CommerceValidationError(
          `Inventory reservation failed for ${item.entityId}: ${result.error?.message ?? "unknown"}`,
        ))
      }

      reservations.push({
        entityId: item.entityId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        orderId: data.checkoutId,
      })
    }

    return Ok(reservations)
  },

  async compensate(reservations, ctx) {
    const inventory = ctx.hook.services.inventory
    for (const r of reservations) {
      await inventory.release({
        ...r,
        performedBy: ctx.hook.actor?.userId ?? "system",
      })
    }
  },
}

/**
 * Step 2: Capture payment.
 *
 * Output: the captured payment intent ID.
 * Compensate: issue a full refund.
 */
export const capturePaymentStep: Step<
  CheckoutData,
  { paymentIntentId: string }
> = {
  id: "capture-payment",

  async run(data, ctx) {
    if (!data.paymentIntentId) {
      return Err(new CommerceValidationError("No authorized payment intent to capture."))
    }

    const result = await ctx.hook.services.payments.capture(data.paymentIntentId)
    if (!result.ok) {
      return Err(new CommerceValidationError(
        `Payment capture failed: ${result.error?.message ?? "unknown"}`,
      ))
    }

    return Ok({ paymentIntentId: data.paymentIntentId })
  },

  async compensate({ paymentIntentId }, ctx) {
    await ctx.hook.services.payments.refund({
      paymentIntentId,
      reason: "Checkout compensation: downstream step failed after payment capture",
    })
  },
}
```

The single AfterHook that drives checkout completion:

```typescript
// In packages/core/src/hooks/checkout.ts
// Replaces the separate capturePayment and reserveInventory AfterHooks.

import { runCompensationChain } from "../kernel/compensation/executor"
import { reserveInventoryStep, capturePaymentStep } from "./checkout-completion"

export const completeCheckout: AfterHook<Order> = async ({ result, context }) => {
  const checkoutData: CheckoutData = {
    checkoutId: result.id,
    cartId: result.cartId,
    customerId: result.customerId,
    currency: result.currency,
    lineItems: result.lineItems,
    paymentIntentId: context.metadata.paymentIntentId as string | undefined,
    // ... remaining fields from the order
  }

  const compensationCtx = {
    tx: context.tx as any,
    hook: context,
  }

  const chainResult = await runCompensationChain(
    [reserveInventoryStep, capturePaymentStep],
    checkoutData,
    compensationCtx,
  )

  if (!chainResult.ok) {
    await context.services.orders.updateStatus(result.id, "failed", chainResult.error.message)
    throw chainResult.error
  }
}
```

The ordering here is deliberate: reserve inventory first, then capture payment. If inventory reservation fails, the customer is never charged. If payment capture fails after inventory reservation, the reserved quantities are released. Both failure modes leave the system in a consistent state.

### 3.6 Plugin step injection (future consideration)

Plugins that need to add steps inside the compensation chain (for example, a fraud check between reservation and capture) can do so through a step registration mechanism on the plugin manifest. This RFC does not implement step injection but acknowledges it as the natural extension:

```typescript
// Future extension to CommercePluginManifest:
checkoutSteps?: (ctx: PluginContext) => {
  position: "before:capture-payment" | "after:reserve-inventory" | string
  step: Step<CheckoutData, unknown>
}[]
```

The core chain covers the baseline. Step injection is additive and can be implemented when a real plugin needs it.

---

## 4. Part 2 -- Inventory Concurrency Safety

### 4.1 The problem

Open `packages/core/src/modules/inventory/service.ts`. The `reserve()` method reads an inventory level row, checks availability, then writes an updated `quantityReserved` value. These are separate database operations with no isolation guarantee between them.

Under concurrent load, two requests can both read the same row, both see sufficient stock, and both write their own reservation. The result: more units reserved than physically exist. This is inventory oversell.

The current schema in `packages/core/src/modules/inventory/schema.ts` has no `version` column and no locking mechanism. The repository methods (`findLevelByKey`, `findLevelsByEntityAndVariant`) issue plain `SELECT` queries.

### 4.2 Why pessimistic locking, not optimistic concurrency

**Optimistic concurrency** adds a `version` integer column. The UPDATE includes `WHERE version = :current_version`. If another request modified the row, zero rows are updated and the caller retries. This works under low contention but produces retry loops when two requests both want the last unit -- both fail, one retries and fails again.

**Pessimistic locking** uses `SELECT ... FOR UPDATE`. PostgreSQL locks the selected rows for the duration of the current transaction. Any other transaction that selects the same rows with `FOR UPDATE` will wait until the first transaction releases them. The lock is held only for the duration of a single `reserve()` call -- a microsecond-level database operation. There is no risk of lock starvation in normal commerce traffic patterns.

We choose pessimistic locking for the reservation path. We also add a `version` column because it is cheap and useful for cache invalidation, ETags, and change detection outside of locking scenarios.

### 4.3 Schema change

```typescript
// packages/core/src/modules/inventory/schema.ts
// Addition to the inventoryLevels table definition:

export const inventoryLevels = pgTable(
  "inventory_levels",
  {
    // ... all existing columns unchanged ...
    // ADD:
    version: integer("version").notNull().default(0),
  },
  // ... existing index unchanged ...
)
```

Migration:

```sql
ALTER TABLE inventory_levels ADD COLUMN version integer NOT NULL DEFAULT 0;
```

This is backward compatible. Existing rows receive `version = 0`. No application code breaks because the column has a default.

### 4.4 Pseudo-code

```
to reserve inventory for a line item:
  BEGIN TRANSACTION (if not already in one)

  SELECT the inventory_levels row matching (entityId, variantId, warehouseId)
  using FOR UPDATE -- this locks the row for the duration of the transaction

  if no row found: return error "no inventory record for this entity"

  compute available = quantityOnHand - quantityReserved
  if available < requested quantity: return error "insufficient stock"

  UPDATE inventory_levels
    SET quantityReserved = quantityReserved + requested_quantity,
        updatedAt = now(),
        version = version + 1
    WHERE id = row.id

  INSERT into inventory_movements (type = 'reservation', ...)

  COMMIT
  return success
```

### 4.5 Repository additions

```typescript
// packages/core/src/modules/inventory/repository/index.ts
// New methods alongside existing ones:

/**
 * Issues SELECT ... FOR UPDATE on the inventory_levels row matching
 * the given entity, variant, and warehouse within the provided transaction.
 *
 * MUST be called inside an active transaction (ctx.tx must be set).
 * Calling outside a transaction provides no locking guarantee.
 */
async findLevelForUpdate(
  entityId: string,
  variantId: string | null,
  warehouseId: string,
  ctx: TxContext,
): Promise<InventoryLevel | undefined> {
  const db = this.getDb(ctx)

  const conditions = [
    eq(inventoryLevels.entityId, entityId),
    eq(inventoryLevels.warehouseId, warehouseId),
    variantId != null
      ? eq(inventoryLevels.variantId, variantId)
      : isNull(inventoryLevels.variantId),
  ]

  const rows = await db
    .select()
    .from(inventoryLevels)
    .where(and(...conditions))
    .for("update")

  return rows[0]
}

/**
 * Performs a read-modify-write under a row-level lock.
 * This is the ONLY correct method for modifying quantityReserved
 * in a concurrent environment. Must be called inside withTransaction().
 */
async reserveWithLock(
  entityId: string,
  variantId: string | null,
  warehouseId: string,
  quantity: number,
  ctx: TxContext,
): Promise<{ ok: true; level: InventoryLevel } | { ok: false; reason: string }> {
  const level = await this.findLevelForUpdate(entityId, variantId, warehouseId, ctx)

  if (!level) {
    return { ok: false, reason: "No inventory record found for this entity." }
  }

  const available = level.quantityOnHand - level.quantityReserved
  if (available < quantity) {
    return {
      ok: false,
      reason: `Insufficient stock. Available: ${available}, requested: ${quantity}.`,
    }
  }

  const updated = await this.getDb(ctx)
    .update(inventoryLevels)
    .set({
      quantityReserved: level.quantityReserved + quantity,
      updatedAt: new Date(),
      version: level.version + 1,
    })
    .where(eq(inventoryLevels.id, level.id))
    .returning()

  return { ok: true, level: updated[0]! }
}
```

### 4.6 Service integration

```typescript
// packages/core/src/modules/inventory/service.ts
// Replace the existing reserve() implementation:

async reserve(input: InventoryReserveInput, actor?: Actor, ctx?: TxContext): Promise<Result<void>> {
  const doReserve = async (txCtx: TxContext): Promise<Result<void>> => {
    const warehouseId = input.warehouseId ?? await this.pickDefaultWarehouse(txCtx)

    const reserveResult = await this.repo.reserveWithLock(
      input.entityId,
      input.variantId ?? null,
      warehouseId,
      input.quantity,
      txCtx,
    )

    if (!reserveResult.ok) {
      return Err(new CommerceValidationError(reserveResult.reason))
    }

    await this.repo.createMovement(
      {
        entityId: input.entityId,
        variantId: input.variantId ?? null,
        warehouseId,
        type: "reservation",
        quantity: input.quantity,
        referenceType: "order",
        referenceId: input.orderId,
        reason: `Reserved for order ${input.orderId}`,
        performedBy: input.performedBy ?? actor?.userId ?? "system",
      },
      txCtx,
    )

    return Ok(undefined)
  }

  // Reuse the caller's transaction if provided; otherwise start a new one.
  if (ctx?.tx) {
    return doReserve(ctx)
  }

  return await withTransaction(this.db, { actor: actor ?? null }, doReserve)
}
```

The key detail: when called from a compensation chain (Part 1), the `ctx` parameter carries the checkout transaction. The lock is held within that transaction. When called standalone, `withTransaction` creates a new one. Both paths are correct.

---

## 5. Part 3 -- Repository Factory

### 5.1 The problem

Every Drizzle repository in the codebase follows the same pattern: `getDb(ctx)`, build a query, return rows. `findById`, `findMany`, `create`, `update`, `delete` -- structurally identical across 15+ modules. This is approximately 200 lines per module, totalling 2000+ lines of pure repetition.

When we add a capability (soft-delete, cursor pagination), we apply the same change 15+ times. When we fix a bug in the base pattern, we fix it 15+ times. This is unsustainable.

### 5.2 What the factory produces

Given a Drizzle `pgTable` schema, `createRepository(table, db)` returns a typed object with:

- `findById(id, ctx?)` -- returns `Row | undefined`
- `findMany(filters?, options?, ctx?)` -- returns `Row[]` with where, orderBy, limit, offset
- `findAndCount(filters?, options?, ctx?)` -- returns `{ rows, total }`
- `create(data, ctx?)` -- inserts and returns
- `createMany(data[], ctx?)` -- batch inserts and returns
- `update(id, data, ctx?)` -- updates by id and returns
- `delete(id, ctx?)` -- hard delete

If the table has a `deleted_at` column, the factory additionally produces:

- `softDelete(id, ctx?)` -- sets `deleted_at` to now
- `restore(id, ctx?)` -- clears `deleted_at`

The return types are inferred from the Drizzle table schema. No type casting at call sites.

### 5.3 Pseudo-code

```
function createRepository(table, db):
  determine whether the table has a deleted_at column
  determine the Row type from table.$inferSelect
  determine the Insert type from table.$inferInsert

  define getDb(ctx): return ctx?.tx or db

  define buildWhereConditions(filters, includeDeleted):
    conditions = []
    if table has deleted_at AND NOT includeDeleted:
      conditions.push(deleted_at IS NULL)
    for each (key, value) in filters:
      if value is defined AND key exists in table:
        conditions.push(key = value)
    return conditions

  findById(id, ctx):
    conditions = buildWhereConditions({}, false)
    conditions.push(id = id)
    SELECT * FROM table WHERE conditions
    return first row or undefined

  findMany(filters, options, ctx):
    conditions = buildWhereConditions(filters, options.withDeleted)
    query = SELECT * FROM table WHERE conditions
    apply limit, offset, orderBy from options
    return rows

  findAndCount(filters, options, ctx):
    rows = findMany(filters, options, ctx)
    total = SELECT COUNT(*) FROM table WHERE same conditions (no limit/offset)
    return { rows, total }

  create(data, ctx):
    INSERT INTO table VALUES (data) RETURNING *
    return first row

  createMany(data, ctx):
    INSERT INTO table VALUES (...data) RETURNING *
    return all rows

  update(id, data, ctx):
    UPDATE table SET data WHERE id = id RETURNING *
    return row or throw NotFound

  delete(id, ctx):
    DELETE FROM table WHERE id = id

  softDelete(id, ctx):  [only if table has deleted_at]
    UPDATE table SET deleted_at = now() WHERE id = id

  restore(id, ctx):  [only if table has deleted_at]
    UPDATE table SET deleted_at = null WHERE id = id RETURNING *
```

### 5.4 Blueprint

```typescript
// packages/core/src/kernel/factory/repository-factory.ts

import {
  eq, and, isNull, sql,
  type SQL, type InferSelectModel, type InferInsertModel,
  type PgTableWithColumns, type TableConfig,
} from "drizzle-orm"
import type { TxContext } from "../database/tx-context"
import type { DrizzleDatabase, DbOrTx } from "../database/drizzle-db"
import { CommerceNotFoundError } from "../errors"

export type Filters<TRow> = Partial<TRow>

export interface FindOptions {
  limit?: number
  offset?: number
  orderBy?: Array<{ column: string; direction: "asc" | "desc" }>
  withDeleted?: boolean
}

export interface BaseRepository<TRow, TInsert> {
  findById(id: string, ctx?: TxContext): Promise<TRow | undefined>
  findMany(filters?: Filters<TRow>, options?: FindOptions, ctx?: TxContext): Promise<TRow[]>
  findAndCount(
    filters?: Filters<TRow>,
    options?: FindOptions,
    ctx?: TxContext,
  ): Promise<{ rows: TRow[]; total: number }>
  create(data: TInsert, ctx?: TxContext): Promise<TRow>
  createMany(data: TInsert[], ctx?: TxContext): Promise<TRow[]>
  update(id: string, data: Partial<TInsert>, ctx?: TxContext): Promise<TRow>
  delete(id: string, ctx?: TxContext): Promise<void>
}

export interface SoftDeletableRepository<TRow, TInsert>
  extends BaseRepository<TRow, TInsert> {
  softDelete(id: string, ctx?: TxContext): Promise<void>
  restore(id: string, ctx?: TxContext): Promise<TRow>
}

type HasDeletedAt<T extends TableConfig> =
  "deleted_at" extends keyof T["columns"] ? true : false

export type RepositoryFor<T extends PgTableWithColumns<any>> =
  HasDeletedAt<T["_"]["config"]> extends true
    ? SoftDeletableRepository<InferSelectModel<T>, InferInsertModel<T>>
    : BaseRepository<InferSelectModel<T>, InferInsertModel<T>>

export function createRepository<T extends PgTableWithColumns<any>>(
  table: T,
  db: DrizzleDatabase,
): RepositoryFor<T> {
  const hasSoftDelete = "deleted_at" in table

  function getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? db
  }

  function buildWhereConditions(
    filters?: Filters<InferSelectModel<T>>,
    includeDeleted = false,
  ): SQL[] {
    const conditions: SQL[] = []
    if (hasSoftDelete && !includeDeleted) {
      conditions.push(isNull((table as any).deleted_at))
    }
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && key in table) {
          conditions.push(eq((table as any)[key], value))
        }
      }
    }
    return conditions
  }

  const repo: BaseRepository<InferSelectModel<T>, InferInsertModel<T>> = {
    async findById(id, ctx) {
      const conditions = buildWhereConditions(undefined, false)
      conditions.push(eq((table as any).id, id))
      const rows = await getDb(ctx).select().from(table).where(and(...conditions))
      return rows[0] as InferSelectModel<T> | undefined
    },

    async findMany(filters, options = {}, ctx) {
      const conditions = buildWhereConditions(filters, options.withDeleted)
      let query = getDb(ctx).select().from(table)
      if (conditions.length > 0) query = query.where(and(...conditions)) as any
      if (options.limit !== undefined) query = query.limit(options.limit) as any
      if (options.offset !== undefined) query = query.offset(options.offset) as any
      return query as unknown as Promise<InferSelectModel<T>[]>
    },

    async findAndCount(filters, options = {}, ctx) {
      const rows = await repo.findMany(filters, options, ctx)
      const conditions = buildWhereConditions(filters, options.withDeleted)
      const countQuery = getDb(ctx)
        .select({ count: sql<number>`count(*)::int` })
        .from(table)
      if (conditions.length > 0) countQuery.where(and(...conditions))
      const countResult = await countQuery
      return { rows, total: countResult[0]?.count ?? 0 }
    },

    async create(data, ctx) {
      const rows = await getDb(ctx).insert(table).values(data as any).returning()
      return rows[0] as InferSelectModel<T>
    },

    async createMany(data, ctx) {
      if (data.length === 0) return []
      const rows = await getDb(ctx).insert(table).values(data as any).returning()
      return rows as InferSelectModel<T>[]
    },

    async update(id, data, ctx) {
      const rows = await getDb(ctx)
        .update(table)
        .set(data as any)
        .where(eq((table as any).id, id))
        .returning()
      if (!rows[0]) throw new CommerceNotFoundError(`Record ${id} not found.`)
      return rows[0] as InferSelectModel<T>
    },

    async delete(id, ctx) {
      await getDb(ctx).delete(table).where(eq((table as any).id, id))
    },
  }

  if (hasSoftDelete) {
    const softRepo = repo as SoftDeletableRepository<
      InferSelectModel<T>, InferInsertModel<T>
    >
    softRepo.softDelete = async (id, ctx) => {
      await getDb(ctx)
        .update(table)
        .set({ deleted_at: new Date() } as any)
        .where(eq((table as any).id, id))
    }
    softRepo.restore = async (id, ctx) => {
      const rows = await getDb(ctx)
        .update(table)
        .set({ deleted_at: null } as any)
        .where(eq((table as any).id, id))
        .returning()
      if (!rows[0]) throw new CommerceNotFoundError(`Record ${id} not found.`)
      return rows[0] as InferSelectModel<T>
    }
    return softRepo as RepositoryFor<T>
  }

  return repo as RepositoryFor<T>
}
```

### 5.5 In-memory counterpart for tests

```typescript
// packages/core/src/kernel/factory/in-memory-repository-factory.ts

export function createInMemoryRepository<
  TRow extends { id: string },
  TInsert,
>(): BaseRepository<TRow, TInsert> & { _store: Map<string, TRow> } {
  const store = new Map<string, TRow>()

  return {
    _store: store,
    async findById(id) { return store.get(id) },
    async findMany(filters) {
      const rows = Array.from(store.values())
      if (!filters) return rows
      return rows.filter(row =>
        Object.entries(filters).every(
          ([k, v]) => v === undefined || (row as any)[k] === v,
        ),
      )
    },
    async findAndCount(filters, options) {
      const rows = await this.findMany(filters)
      const offset = options?.offset ?? 0
      const paginated = options?.limit
        ? rows.slice(offset, offset + options.limit)
        : rows
      return { rows: paginated, total: rows.length }
    },
    async create(data) {
      const id = (data as any).id ?? crypto.randomUUID()
      const row = { ...data, id } as unknown as TRow
      store.set(id, row)
      return row
    },
    async createMany(data) {
      return Promise.all(data.map(d => this.create(d)))
    },
    async update(id, data) {
      const existing = store.get(id)
      if (!existing) throw new CommerceNotFoundError(`Record ${id} not found.`)
      const updated = { ...existing, ...data } as TRow
      store.set(id, updated)
      return updated
    },
    async delete(id) { store.delete(id) },
  }
}
```

### 5.6 Usage pattern

Modules with no domain-specific queries delete their repository file entirely:

```typescript
// Before: 200 lines in packages/core/src/modules/promotions/repository/index.ts
// After: deleted. In PromotionsService constructor:
this.repo = createRepository(schema.promotions, db)
this.ruleRepo = createRepository(schema.promotionRules, db)
```

Modules with domain-specific queries keep their repository class but delegate standard CRUD:

```typescript
export class InventoryRepository {
  private levelBase = createRepository(schema.inventoryLevels, db)

  // Delegate standard methods
  findAllLevels(ctx?: TxContext) {
    return this.levelBase.findMany(undefined, undefined, ctx)
  }

  // Domain-specific methods remain
  async findLevelForUpdate(...) { ... }
  async reserveWithLock(...) { ... }
}
```

---

## 6. Part 4 -- Access Composition

### 6.1 The problem

The current permission model in `packages/core/src/auth/permissions.ts` provides `assertPermission(actor, required)` and `assertOwnership(actor, resourceOwnerId)`. These are imperative checks that either pass or throw. They do not compose. They do not support query-level filtering.

Consider the access rule: "Admins can see all orders. Customers can only see their own orders. Guests see nothing." Today this requires custom code in every route handler that deals with orders. There is no reusable composition.

PayloadCMS solved this with three pure utility functions and a return type that is either a boolean or a WHERE clause. The WHERE clause return is the key insight: instead of the access function deciding "yes or no," it can return a database filter that narrows results to only what the caller is allowed to see.

### 6.2 Pseudo-code

```
type AccessResult = boolean | WhereClause
type AccessFn = (ctx: AccessContext) -> AccessResult

function accessOR(fns):
  return (ctx):
    queries = []
    for each fn in fns:
      result = fn(ctx)
      if result is true: return true          -- full access, short circuit
      if result is WhereClause: queries.push(result)
    if queries.length > 0: return OR(queries)  -- partial access via filter
    return false                               -- no access

function accessAND(fns):
  return (ctx):
    queries = []
    for each fn in fns:
      result = fn(ctx)
      if result is false: return false         -- no access, short circuit
      if result is WhereClause: queries.push(result)
    if queries.length > 0: return AND(queries) -- narrowed access via filter
    return true                                -- full access

function conditional(condition, accessFn, fallback):
  return (ctx):
    if condition is function: applies = condition(ctx)
    else: applies = condition
    if applies: return accessFn(ctx)
    return fallback(ctx)
```

### 6.3 Blueprint

```typescript
// packages/core/src/auth/access.ts

export type WhereClause = Record<string, unknown>
export type AccessResult = boolean | WhereClause

export type AccessContext<TData = unknown> = {
  actor: Actor | null
  data?: TData
  id?: string
  req: CommerceRequest
}

export type AccessFn<TData = unknown> = (
  ctx: AccessContext<TData>,
) => AccessResult | Promise<AccessResult>

function combineWhere(
  queries: WhereClause[],
  operator: "and" | "or",
): WhereClause {
  if (queries.length === 1) return queries[0]!
  return { [operator]: queries }
}

export const accessOR = <TData = unknown>(
  ...fns: Array<AccessFn<TData>>
): AccessFn<TData> => {
  return async (ctx) => {
    const queries: WhereClause[] = []
    for (const fn of fns) {
      const result = await fn(ctx)
      if (result === true) return true
      if (result && typeof result === "object") queries.push(result)
    }
    if (queries.length > 0) return combineWhere(queries, "or")
    return false
  }
}

export const accessAND = <TData = unknown>(
  ...fns: Array<AccessFn<TData>>
): AccessFn<TData> => {
  return async (ctx) => {
    const queries: WhereClause[] = []
    for (const fn of fns) {
      const result = await fn(ctx)
      if (result === false) return false
      if (result !== true && result && typeof result === "object") {
        queries.push(result)
      }
    }
    if (queries.length > 0) return combineWhere(queries, "and")
    return true
  }
}

export const conditional = <TData = unknown>(
  condition: ((ctx: AccessContext<TData>) => boolean) | boolean,
  accessFn: AccessFn<TData>,
  fallback: AccessFn<TData> = () => false,
): AccessFn<TData> => {
  return async (ctx) => {
    const applies = typeof condition === "function" ? condition(ctx) : condition
    return applies ? accessFn(ctx) : fallback(ctx)
  }
}
```

### 6.4 Built-in access functions

Ship commonly needed access functions alongside the composition utilities:

```typescript
// packages/core/src/auth/access-fns.ts

export const isAdmin: AccessFn = ({ actor }) => {
  return actor?.role === "admin"
}

export const isAuthenticated: AccessFn = ({ actor }) => {
  return actor != null
}

export const isDocumentOwner = (ownerField = "customerId"): AccessFn => {
  return ({ actor, data }) => {
    if (!actor || !data) return false
    return (data as any)[ownerField] === actor.userId
  }
}

export const publicAccess: AccessFn = () => true
```

### 6.5 Usage at the route level

```typescript
// packages/core/src/interfaces/rest/routes/orders.ts

const orderReadAccess = accessOR(
  isAdmin,
  isDocumentOwner("customerId"),
)

app.get("/orders", async (c) => {
  const actor = c.get("actor")
  const accessResult = await orderReadAccess({ actor, req: c.req })

  if (accessResult === false) return c.json({ error: "Forbidden" }, 403)

  // If accessResult is true, list all orders.
  // If accessResult is a WhereClause, pass it as a filter.
  const filters = accessResult === true ? {} : accessResult
  const orders = await services.orders.list(filters, pagination)
  return c.json(orders)
})
```

This reads as natural English. There is no bespoke access DSL, no middleware chain, no permission flag table. Just composable functions with well-defined semantics.

### 6.6 Relationship to existing permissions.ts

The existing `assertPermission` and `assertOwnership` functions continue to work for simple imperative checks. `accessOR`, `accessAND`, and `conditional` are additive -- they do not replace the existing permission system but provide a higher-level composition model that routes and services can adopt incrementally. Over time, route-level access checks should migrate to the composed model.

---

## 7. Part 5 -- Request Context and Hook Enrichment

### 7.1 The problem

`HookContext` in `packages/core/src/kernel/hooks/types.ts` currently has: `actor`, `tx`, `logger`, `services`, `metadata`. The `metadata` field is `Record<string, unknown>` -- effectively a per-request scratchpad.

Three things are missing:

1. The field is named `metadata`, but the PayloadCMS ecosystem and broader Node.js community use `context` for per-request scratchpads. Naming alignment matters for developer ergonomics.
2. Hooks cannot determine how they were triggered (REST request, local API call, MCP tool call). Some hooks need to behave differently based on call origin.
3. Hooks cannot enqueue background jobs because the `jobs` adapter is not on the context.

### 7.2 What changes

```typescript
// packages/core/src/kernel/hooks/types.ts

export interface HookContext {
  actor: Actor | null
  tx: unknown
  logger: Logger
  services: ServiceContainer
  context: Record<string, unknown>   // renamed from metadata
  requestId: string                  // new: UUID for distributed tracing
  origin: "rest" | "local" | "mcp"   // new: call origin
  jobs: JobsAdapter                  // new: background job enqueue
}
```

The `origin` field: when a hook is triggered from the REST API, origin is `"rest"`. When triggered from the Local API (Part 7), origin is `"local"`. When triggered from an MCP tool, origin is `"mcp"`. Example use: a notification hook might skip sending if origin is `"local"` (an internal operation) but send if origin is `"rest"` (a user action).

The `jobs` field: always set. If no jobs adapter is configured, it is a `NullJobsAdapter` that silently drops enqueue calls. Hooks can always call `context.jobs.enqueue(...)` without checking whether a jobs adapter exists.

### 7.3 Migration path for metadata to context

To avoid breaking existing code that references `metadata`:

```typescript
// During the transition period, create context with a deprecated metadata getter:
function createHookContext(args: CreateHookContextArgs): HookContext {
  const ctx: HookContext = {
    actor: args.actor,
    tx: args.tx,
    logger: args.logger,
    services: args.services,
    context: args.context ?? {},
    requestId: args.requestId ?? crypto.randomUUID(),
    origin: args.origin ?? "rest",
    jobs: args.jobs ?? new NullJobsAdapter(),
  }

  // Temporary backward compat -- remove after one release cycle:
  Object.defineProperty(ctx, "metadata", {
    get() { return ctx.context },
    set(v: Record<string, unknown>) { Object.assign(ctx.context, v) },
  })

  return ctx
}
```

---

## 8. Part 6 -- Database-Backed Job Queue

### 8.1 The problem

Plugins have no safe way to defer work. A hook either runs synchronously (blocking the HTTP response) or fires without awaiting (unsafe in serverless -- the invocation may terminate before completion).

RFC-003 proposed a `JobsAdapter` interface with a `NullJobsAdapter` as default. This RFC builds on that by providing a built-in `DrizzleJobsAdapter` that stores jobs in the application's own PostgreSQL database. Zero external dependencies. Serverless-compatible. Queryable and debuggable with standard SQL tooling.

### 8.2 Why not an event bus

This design explicitly rejects a pub-sub event bus as a core primitive:

1. In serverless, an in-process event bus is meaningless -- each invocation is isolated. Listeners in invocation A do not exist in invocation B.
2. A cross-invocation event bus requires Redis Pub/Sub, SQS, or similar, introducing vendor coupling.
3. The hook system already covers 90% of what developers reach for an event bus to do.

The remaining 10% is background work: send emails, reindex search, sync to ERP. For this, we provide a job queue. Hooks for synchronous side effects, jobs for deferred work.

### 8.3 Schema

```typescript
// packages/core/src/kernel/jobs/schema.ts

export const commerceJobs = pgTable("commerce_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  queue: text("queue").notNull().default("default"),
  taskSlug: text("task_slug").notNull(),
  input: jsonb("input").notNull().default("{}"),
  output: jsonb("output"),
  status: text("status", {
    enum: ["pending", "processing", "succeeded", "failed"],
  }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(1),
  error: text("error"),
  waitUntil: timestamp("wait_until", { withTimezone: true }),
  concurrencyKey: text("concurrency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
})
```

### 8.4 Pseudo-code

```
to enqueue a job:
  if options.concurrencyKey AND options.supersedes:
    DELETE FROM commerce_jobs
    WHERE concurrency_key = options.concurrencyKey AND status = 'pending'
  INSERT INTO commerce_jobs (task_slug, input, queue, max_attempts, wait_until, concurrency_key)

to run pending jobs:
  BEGIN TRANSACTION
  SELECT up to {limit} rows FROM commerce_jobs
    WHERE status = 'pending'
      AND (wait_until IS NULL OR wait_until <= now())
      AND queue = {queue}
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED    -- critical: allows parallel runners without conflicts

  for each job:
    mark job as processing (status = 'processing', processing_started_at = now())
  COMMIT

  for each job:
    look up the task handler by job.taskSlug
    if no handler: mark failed with "unknown task"
    try:
      result = handler(job.input)
      mark succeeded (status = 'succeeded', output = result, completed_at = now())
    catch error:
      increment attempts
      if attempts >= maxAttempts:
        mark failed (status = 'failed', error = error.message)
      else:
        compute next wait_until using backoff strategy
        mark pending (status = 'pending', wait_until = computed)
```

The `FOR UPDATE SKIP LOCKED` clause is critical. It allows multiple runner instances to process jobs in parallel without conflicts. If two runners query at the same time, each gets a different set of jobs. This is how pg-boss works internally and it is the standard pattern for database-backed job queues in PostgreSQL.

### 8.5 Task definition types

```typescript
// packages/core/src/kernel/jobs/types.ts

export type TaskDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> = {
  slug: string
  handler: (args: {
    input: TInput
    ctx: TaskContext
  }) => Promise<{ output: TOutput }>
  retries?: {
    attempts: number
    backoff?: { type: "fixed" | "exponential"; delay: number }
  }
  concurrency?: {
    key: (input: TInput) => string
    exclusive?: boolean
    supersedes?: boolean
  }
}

export type TaskContext = {
  logger: Logger
  db: DrizzleDatabase
  services: ServiceContainer
}
```

### 8.6 Adapter interface and implementations

```typescript
// packages/core/src/kernel/jobs/adapter.ts

export interface JobsAdapter {
  enqueue(
    slug: string,
    input: Record<string, unknown>,
    options?: JobEnqueueOptions,
  ): Promise<void>
}

export interface JobEnqueueOptions {
  delayMs?: number
  queue?: string
  concurrencyKey?: string
  supersedes?: boolean
  maxAttempts?: number
}

/**
 * NullJobsAdapter: the default. Enqueue calls are silently dropped.
 * Safe to call in all environments. No-op by design.
 */
export class NullJobsAdapter implements JobsAdapter {
  async enqueue() {}
}
```

```typescript
// packages/core/src/kernel/jobs/drizzle-adapter.ts

export class DrizzleJobsAdapter implements JobsAdapter {
  constructor(
    private db: DrizzleDatabase,
    private tasks: Map<string, TaskDefinition>,
  ) {}

  async enqueue(
    slug: string,
    input: Record<string, unknown>,
    options?: JobEnqueueOptions,
  ): Promise<void> {
    if (options?.concurrencyKey && options?.supersedes) {
      await this.db
        .delete(commerceJobs)
        .where(
          and(
            eq(commerceJobs.concurrencyKey, options.concurrencyKey),
            eq(commerceJobs.status, "pending"),
          ),
        )
    }

    await this.db.insert(commerceJobs).values({
      taskSlug: slug,
      input,
      queue: options?.queue ?? "default",
      maxAttempts: options?.maxAttempts ?? 1,
      waitUntil: options?.delayMs
        ? new Date(Date.now() + options.delayMs)
        : null,
      concurrencyKey: options?.concurrencyKey ?? null,
    })
  }
}
```

### 8.7 Job runner

```typescript
// packages/core/src/kernel/jobs/runner.ts

export async function runPendingJobs(args: {
  db: DrizzleDatabase
  tasks: Map<string, TaskDefinition>
  queue?: string
  limit?: number
  logger: Logger
  services: ServiceContainer
}): Promise<{ processed: number; failed: number }> {
  const { db, tasks, queue = "default", limit = 10, logger, services } = args
  let processed = 0
  let failed = 0

  // Claim jobs using FOR UPDATE SKIP LOCKED
  const claimed = await db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(commerceJobs)
      .where(
        and(
          eq(commerceJobs.status, "pending"),
          eq(commerceJobs.queue, queue),
          sql`(${commerceJobs.waitUntil} IS NULL OR ${commerceJobs.waitUntil} <= now())`,
        ),
      )
      .orderBy(commerceJobs.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true })

    for (const job of pending) {
      await tx
        .update(commerceJobs)
        .set({
          status: "processing",
          processingStartedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(commerceJobs.id, job.id))
    }

    return pending
  })

  // Process each claimed job outside the claim transaction
  for (const job of claimed) {
    const task = tasks.get(job.taskSlug)

    if (!task) {
      await db
        .update(commerceJobs)
        .set({
          status: "failed",
          error: `Unknown task slug: ${job.taskSlug}`,
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(commerceJobs.id, job.id))
      failed++
      continue
    }

    try {
      const result = await task.handler({
        input: job.input as any,
        ctx: { logger, db, services },
      })

      await db
        .update(commerceJobs)
        .set({
          status: "succeeded",
          output: result.output,
          attempts: job.attempts + 1,
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(commerceJobs.id, job.id))

      processed++
    } catch (err) {
      const attempts = job.attempts + 1
      const maxAttempts = job.maxAttempts

      if (attempts >= maxAttempts) {
        await db
          .update(commerceJobs)
          .set({
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            attempts,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(commerceJobs.id, job.id))
        failed++
      } else {
        // Compute backoff delay
        const retries = task.retries
        const delay = retries?.backoff?.type === "exponential"
          ? retries.backoff.delay * Math.pow(2, attempts - 1)
          : retries?.backoff?.delay ?? 1000

        await db
          .update(commerceJobs)
          .set({
            status: "pending",
            error: err instanceof Error ? err.message : String(err),
            attempts,
            waitUntil: new Date(Date.now() + delay),
            updatedAt: new Date(),
          })
          .where(eq(commerceJobs.id, job.id))
      }
    }
  }

  return { processed, failed }
}
```

### 8.8 Config integration

```typescript
// In CommerceConfig:
export interface CommerceConfig {
  // ... existing fields ...
  jobs?: {
    adapter?: JobsAdapter
    tasks?: TaskDefinition[]
    autorun?: {
      enabled: boolean
      intervalMs: number  // default: 5000
    }
  }
}
```

```typescript
// commerce.config.ts
export default defineConfig({
  jobs: {
    adapter: new DrizzleJobsAdapter(db, taskMap),
    tasks: [sendOrderConfirmationTask, syncInventoryTask],
    autorun: {
      enabled: process.env.NODE_ENV !== "production",
      intervalMs: 5000,
    },
  },
})
```

In production, expose a `POST /api/jobs/run` endpoint protected by an API key or secret header. Wire it to a Vercel Cron, AWS EventBridge, or any other scheduler that can hit an HTTP endpoint on a cadence.

### 8.9 Enqueue from hooks

```typescript
// In any AfterHook:
export const afterOrderCreate: AfterHook<Order> = async ({ result, context }) => {
  await context.jobs.enqueue("send-order-confirmation", {
    orderId: result.id,
    customerEmail: result.customerEmail,
  })
  // The HTTP response returns immediately.
  // The email sends when the runner processes the job.
}
```

---

## 9. Part 7 -- Local API

### 9.1 The problem

Services are called directly in hooks: `context.services.orders.create(...)`. This works but has a critical gap: when you call a service directly, the hooks registered for that operation do not fire. If plugin A registers an `afterOrderCreate` hook, and plugin B creates an order via `context.services.orders.create()`, plugin A's hook never runs.

PayloadCMS solves this with a Local API: `payload.create({ collection: 'orders', data })` calls the same operation pipeline as the REST API, running all hooks, within the same transaction. No HTTP roundtrip, no JSON serialization.

For a checkout that needs to read the cart, apply promotions, capture payment, and create an order -- all as internal function calls within one transaction -- this is essential.

### 9.2 Pseudo-code

```
class LocalAPI:
  constructor(ctx: HookContext, kernel: CommerceKernel)

  orders:
    create(data):
      run beforeOrderCreate hooks with ctx and data
      if any hook returns error: return error
      result = ordersService.create(modified data, ctx.tx)
      if error: return error
      run afterOrderCreate hooks with ctx and result
      return result

    findById(id):
      result = ordersService.findById(id, ctx.tx)
      run afterOrderRead hooks with ctx and result
      return result

  catalog:
    findById(id):
      result = catalogService.findById(id, ctx.tx)
      run afterProductRead hooks with ctx and result
      return result

  // ... one namespace per module
```

### 9.3 Blueprint

```typescript
// packages/core/src/kernel/local-api.ts

import type { HookContext } from "./hooks/types"
import type { CommerceKernel } from "../runtime/kernel"
import type { Result } from "./result"

export class LocalAPI {
  constructor(
    private ctx: HookContext,
    private kernel: CommerceKernel,
  ) {}

  readonly orders = {
    create: async (data: CreateOrderInput): Promise<Result<Order>> => {
      // Override origin to "local" so hooks know this is an internal call
      const localCtx = { ...this.ctx, origin: "local" as const }

      const beforeResult = await this.kernel.hooks.runBefore(
        "orderCreate", data, localCtx,
      )
      if (!beforeResult.ok) return beforeResult

      const created = await this.kernel.services.orders.create(
        beforeResult.value,
        localCtx.tx,
      )
      if (!created.ok) return created

      await this.kernel.hooks.runAfter("orderCreate", created.value, localCtx)
      return created
    },

    findById: async (id: string): Promise<Result<Order>> => {
      const localCtx = { ...this.ctx, origin: "local" as const }
      const result = await this.kernel.services.orders.findById(id, localCtx.tx)
      if (result.ok) {
        await this.kernel.hooks.runAfter("orderRead", result.value, localCtx)
      }
      return result
    },
  }

  readonly catalog = {
    findById: async (id: string): Promise<Result<Product>> => {
      const localCtx = { ...this.ctx, origin: "local" as const }
      const result = await this.kernel.services.catalog.findById(id, localCtx.tx)
      if (result.ok) {
        await this.kernel.hooks.runAfter("productRead", result.value, localCtx)
      }
      return result
    },

    list: async (
      filters?: Record<string, unknown>,
      pagination?: { limit?: number; offset?: number },
    ): Promise<Result<{ items: Product[]; total: number }>> => {
      const localCtx = { ...this.ctx, origin: "local" as const }
      return this.kernel.services.catalog.list(filters, pagination, localCtx.tx)
    },
  }

  // Additional module namespaces follow the same pattern.
  // Each module gets: create, findById, list, update, delete
  // with before/after hooks sandwiching the service call.
}
```

### 9.4 Making it available

Add `localApi` to `HookContext` or make it constructable from any hook:

```typescript
// In the hook execution pipeline:
const localApi = new LocalAPI(hookContext, kernel)

// Hooks can then use:
export const myHook: AfterHook<Order> = async ({ result, context }) => {
  const localApi = new LocalAPI(context, context.kernel)
  const product = await localApi.catalog.findById(result.lineItems[0].productId)
  // product was fetched with hooks running, inside the same transaction
}
```

The `kernel` reference needs to be available on `HookContext`. Add it as `kernel: CommerceKernel` alongside `services`. This is a safe addition because the kernel is already the owner of the hook context construction.

---

## 10. Part 8 -- Audit Log

### 10.1 The problem

The `orders` table has a `status` field managed by a state machine. When an order moves from `pending` to `confirmed` to `fulfilled`, there is no record of when those transitions happened, who triggered them, or what the order data looked like at each point. For financial records, this is a compliance gap.

Full document versioning (like PayloadCMS does) is complex. What is immediately useful is an append-only audit log that records events with actor, timestamp, and a JSON payload of what changed.

### 10.2 Schema

```typescript
// packages/core/src/modules/audit/schema.ts

export const auditLog = pgTable("commerce_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").notNull().default("{}"),
  actorId: text("actor_id"),
  actorType: text("actor_type"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
```

Index for efficient lookup:

```sql
CREATE INDEX idx_audit_entity ON commerce_audit_log(entity_type, entity_id, created_at DESC);
```

### 10.3 Service

```typescript
// packages/core/src/modules/audit/service.ts

export type AuditService = {
  record(args: {
    entityType: string
    entityId: string
    event: string
    payload?: Record<string, unknown>
    ctx: HookContext
  }): Promise<void>

  listForEntity(args: {
    entityType: string
    entityId: string
    limit?: number
    ctx?: TxContext
  }): Promise<AuditEntry[]>
}
```

### 10.4 Integration

Add `audit: AuditService` to `HookContext.services`. The order state machine calls `audit.record()` automatically on every transition:

```typescript
// In the order state machine transition logic:
async function transitionOrderStatus(
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
  ctx: HookContext,
): Promise<Result<Order>> {
  // ... validate transition is allowed ...
  const updated = await services.orders.update(orderId, { status: to }, ctx.tx)

  await ctx.services.audit.record({
    entityType: "order",
    entityId: orderId,
    event: "status_changed",
    payload: { from, to },
    ctx,
  })

  return updated
}
```

Hooks that perform significant mutations should also call `audit.record()`:

```typescript
// After a refund:
await context.services.audit.record({
  entityType: "order",
  entityId: orderId,
  event: "refunded",
  payload: { amount, reason, paymentIntentId },
  ctx: context,
})
```

---

## 11. Part 9 -- Plugin Config Transformation and Schema Extension

### 11.1 Plugin config transformation

The current plugin system uses `defineCommercePlugin` which returns a `CommercePluginManifest` object. The kernel collects manifests and wires them together at boot. This works but is more complex than necessary.

PayloadCMS defines a plugin as `(config: Config) => Config`. A plugin is just a config transform function. This is trivially composable and immediately readable.

The change: `defineCommercePlugin` stays as the developer-friendly wrapper, but its return type changes from `CommercePluginManifest` to `CommercePlugin` (a config transform function). Developers who know what they are doing can also write a config transform directly.

```typescript
// packages/core/src/kernel/plugin/types.ts

export type CommercePlugin = (
  config: CommerceConfig,
) => CommerceConfig | Promise<CommerceConfig>

export function defineCommercePlugin<TManifest extends CommercePluginManifest>(
  manifest: TManifest,
): CommercePlugin {
  return async (config: CommerceConfig): Promise<CommerceConfig> => {
    if (manifest.schema) {
      config.database.schemas = [
        ...(config.database.schemas ?? []),
        manifest.schema,
      ]
    }
    if (manifest.routes) {
      config.routes = [
        ...(config.routes ?? []),
        ...manifest.routes(config),
      ]
    }
    for (const [operation, hooks] of Object.entries(manifest.hooks ?? {})) {
      const op = operation as HookOperation
      config.hooks[op] = [...(config.hooks[op] ?? []), ...(hooks as any)]
    }
    if (manifest.mcpTools) {
      config.mcp.tools = [
        ...(config.mcp.tools ?? []),
        ...manifest.mcpTools,
      ]
    }
    return config
  }
}
```

The `defineConfig` function applies plugins before freezing:

```typescript
export async function defineConfig(
  input: CommerceConfigInput,
): Promise<CommerceConfig> {
  let config = applyDefaults(input)
  for (const plugin of config.plugins ?? []) {
    config = await plugin(config)
  }
  return Object.freeze(config)
}
```

### 11.2 Schema extension via extraColumns

Every core module that defines a table should accept additional column definitions from the developer. The pattern: "give me the defaults, I augment."

```typescript
// packages/core/src/modules/catalog/index.ts

export type CatalogModuleOptions = {
  extraColumns?: (
    baseColumns: typeof baseCatalogColumns,
  ) => Record<string, PgColumnBuilderBase>
}

export function createCatalogModule(
  options?: CatalogModuleOptions,
) {
  const extraColumns = options?.extraColumns?.(baseCatalogColumns) ?? {}

  const products = pgTable("products", {
    ...baseCatalogColumns,
    ...extraColumns,
  })

  return {
    schema: { products },
    repository: createRepository(products, db),
  }
}
```

At the config level:

```typescript
// commerce.config.ts
export default defineConfig({
  modules: {
    catalog: createCatalogModule({
      extraColumns: (base) => ({
        supplierCode: text("supplier_code"),
        gtin: text("gtin").unique(),
      }),
    }),
  },
})
```

The developer does not add columns via migration files or config toggles. They compose with the defaults. The Drizzle schema inference picks up the extra columns automatically, so `$inferSelect` on the resulting table includes `supplierCode` and `gtin`.

---

## 12. Part 10 -- Injectable Matchers and Adapter Self-Description

### 12.1 CartItemMatcher

The cart module's `addItem` currently determines item uniqueness by `productId` + `variantId`. This is hardcoded. A developer selling customizable products (engraving, gift notes) cannot distinguish two items with the same product and variant but different customization without forking the cart module.

The fix: accept a `cartItemMatcher` function in the cart module config.

```typescript
// packages/core/src/modules/cart/types.ts

export type CartItemMatcher = (args: {
  existingItem: CartLineItem
  newItem: {
    productId: string
    variantId: string | null
    [key: string]: unknown
  }
}) => boolean

export const defaultCartItemMatcher: CartItemMatcher = ({ existingItem, newItem }) =>
  existingItem.entityId === newItem.productId &&
  existingItem.variantId === newItem.variantId
```

In the cart service's `addItem`:

```typescript
// packages/core/src/modules/cart/service.ts

async addItem(input: AddCartItemInput, actor?: Actor, ctx?: TxContext) {
  const existingItems = await this.repo.findLineItemsByCartId(input.cartId, ctx)
  const matcher = this.config.cartItemMatcher ?? defaultCartItemMatcher

  const match = existingItems.find(existing =>
    matcher({ existingItem: existing, newItem: input }),
  )

  if (match) {
    // Increment quantity instead of adding duplicate
    return this.updateQuantity({
      cartId: input.cartId,
      itemId: match.id,
      quantity: match.quantity + input.quantity,
    }, actor, ctx)
  }

  // No match -- insert new line item
  return this.repo.createLineItem({ ... }, ctx)
}
```

### 12.2 PaymentAdapter extraColumns

The current `PaymentAdapter` in `packages/core/src/modules/payments/adapter.ts` defines `createPaymentIntent`, `capturePayment`, `refundPayment`, `cancelPaymentIntent`, `verifyWebhook`. It does not have a mechanism for adapters to contribute schema columns.

A Stripe adapter needs `stripeCustomerId` and `stripePaymentIntentId`. A bank transfer adapter needs `bankReference` and `transferCode`. Today these must go into a loose JSON blob or be hardcoded in the core schema.

Add an optional `extraColumns` factory to `PaymentAdapter`:

```typescript
// packages/core/src/modules/payments/adapter.ts

export type PaymentAdapter = {
  readonly providerId: string
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<Result<PaymentIntent>>
  capturePayment(paymentIntentId: string, amount?: number): Promise<Result<PaymentCapture>>
  refundPayment(paymentId: string, amount: number, reason?: string): Promise<Result<PaymentRefund>>
  cancelPaymentIntent(paymentIntentId: string): Promise<Result<void>>
  verifyWebhook(request: Request): Promise<Result<PaymentWebhookEvent>>

  /**
   * Optional: columns this adapter wants stored on the payments table.
   * Column names should be prefixed with the adapter name to avoid conflicts.
   */
  extraColumns?(): Record<string, PgColumnBuilderBase>
}
```

The payments module merges adapter columns at table creation:

```typescript
// packages/core/src/modules/payments/schema.ts

export function buildPaymentsSchema(adapters: PaymentAdapter[]) {
  const adapterColumns: Record<string, PgColumnBuilderBase> = {}

  for (const adapter of adapters) {
    const extra = adapter.extraColumns?.() ?? {}
    for (const [key, col] of Object.entries(extra)) {
      adapterColumns[`${adapter.providerId}_${key}`] = col
    }
  }

  return pgTable("payments", {
    ...basePaymentColumns,
    ...adapterColumns,
  })
}
```

Each adapter owns its columns. The engine stays adapter-agnostic. Everything is typed and queryable via standard SQL -- no JSON blobs.

---

## 13. Part 11 -- Guest Cart

### 13.1 The problem

The cart schema has a `customerId` column. There is no guest cart concept. Anonymous cart creation is not supported -- the auth middleware rejects unauthenticated requests to cart endpoints.

Every ecommerce store needs guest carts. A user browses, adds items, then decides to log in or create an account to checkout. Their cart must not disappear. This has to be designed into the system, not bolted on after the fact.

### 13.2 Schema change

```typescript
// packages/core/src/modules/cart/schema.ts
// Addition to the carts table:

export const carts = pgTable("carts", {
  // ... existing columns ...
  // customerId remains nullable (null = guest cart)
  secret: text("secret"),  // NEW: set for guest carts, used for access control
})
```

### 13.3 Access control

```typescript
// packages/core/src/modules/cart/access.ts

export function canAccessCart(
  actor: Actor | null,
  cart: Cart,
  providedSecret?: string,
): boolean {
  // Authenticated owner
  if (actor && cart.customerId && actor.customerId === cart.customerId) {
    return true
  }
  // Valid secret (guest access)
  if (providedSecret && cart.secret && providedSecret === cart.secret) {
    return true
  }
  return false
}
```

### 13.4 Cart creation for guests

```typescript
// In cart service:
async createGuestCart(currency: string): Promise<Result<{ cart: Cart; secret: string }>> {
  const secret = crypto.randomUUID()
  const cart = await this.repo.create({
    customerId: null,
    status: "active",
    currency,
    secret,
    expiresAt: new Date(Date.now() + this.config.ttlMinutes * 60 * 1000),
  })
  return Ok({ cart, secret })
}
```

The `secret` is returned to the caller (stored in a cookie or local storage). Subsequent requests include the secret to access the cart.

### 13.5 Cart merge on login

```typescript
async mergeCarts(
  targetCartId: string,
  sourceCartId: string,
  sourceSecret: string,
  actor: Actor,
  ctx?: TxContext,
): Promise<Result<Cart>> {
  const sourceCart = await this.repo.findById(sourceCartId, ctx)
  if (!sourceCart || sourceCart.secret !== sourceSecret) {
    return Err(new CommerceForbiddenError("Invalid cart secret."))
  }

  const sourceItems = await this.repo.findLineItemsByCartId(sourceCartId, ctx)
  const matcher = this.config.cartItemMatcher ?? defaultCartItemMatcher

  for (const item of sourceItems) {
    await this.addItem({
      cartId: targetCartId,
      productId: item.entityId,
      variantId: item.variantId,
      quantity: item.quantity,
      metadata: item.metadata,
    }, actor, ctx)
    // addItem handles deduplication via the cartItemMatcher
  }

  // Mark source cart as merged
  await this.repo.update(sourceCartId, { status: "merged" }, ctx)

  const mergedCart = await this.repo.findById(targetCartId, ctx)
  return Ok(mergedCart!)
}
```

Note how `mergeCarts` uses `addItem` (which uses the `CartItemMatcher` from Part 10) rather than raw inserts. This ensures deduplication logic is applied consistently.

---

## 14. Part 12 -- Query Composition Layer

### 14.1 The problem

API route handlers that return resources with related data currently call multiple services and manually assemble the response:

```typescript
const orderResult = await services.orders.getById(id)
const customerResult = await services.customers.getByUserId(orderResult.value.customerId)
const paymentResult = await services.payments.getByOrderId(id)
return { ...orderResult.value, customer: ..., payment: ... }
```

This pattern repeats in every route that needs related data. It does not batch (three sequential database round-trips). It puts data-assembly logic in HTTP handlers, which is the wrong layer. When a consumer needs different related data, a new route or service method must be written.

### 14.2 The batching requirement

A naive include implementation that fetches related records in a loop produces N+1 queries. For 50 orders each with a customer: 1 + 50 = 51 queries. The correct implementation collects all foreign key values, issues a single `WHERE id IN (...)` query per relation, then maps results in memory. For 50 orders: 2 queries regardless of count. This is the dataloader pattern.

### 14.3 Pseudo-code

```
define a Relation as:
  foreignKey: string (the key on the parent row, e.g. "customerId")
  targetService: string (e.g. "customers")
  batchMethod: string (the service method that accepts string[] and returns records)
  attachAs: string (the key to set on the parent row)
  isList: boolean (true for one-to-many)

kernel.query({ entity, id?, filters?, include?, pagination? }):
  1. Fetch primary records via the entity's service

  2. For each include path:
     a. Collect all foreign key values from primary records (deduplicated)
     b. Call batchMethod with the collected IDs (one WHERE IN query)
     c. Build a lookup Map<foreignKeyValue, relatedRecord>
     d. Attach results to primary records

  3. For nested includes (e.g. "items.product"):
     a. After resolving "items", flatten all items across all primary records
     b. Collect foreign keys, batch-fetch, attach -- same pattern

  4. Return enriched records
```

### 14.4 Registry and executor

```typescript
// packages/core/src/kernel/query/registry.ts

export interface RelationDefinition {
  foreignKey: string
  targetService: string
  batchMethod: string
  attachAs: string
  isList?: boolean
}

export interface EntityDefinition {
  service: string
  getByIdMethod: string
  listMethod: string
  relations: Record<string, RelationDefinition>
}

export class QueryRegistry {
  private entities = new Map<string, EntityDefinition>()

  register(name: string, definition: EntityDefinition): void {
    this.entities.set(name, definition)
  }

  get(name: string): EntityDefinition | undefined {
    return this.entities.get(name)
  }
}
```

```typescript
// packages/core/src/kernel/query/executor.ts

export interface QueryInput {
  entity: string
  id?: string
  filters?: Record<string, unknown>
  include?: string[]
  pagination?: { limit?: number; offset?: number }
}

export async function executeQuery<T = Record<string, unknown>>(
  registry: QueryRegistry,
  services: Record<string, unknown>,
  input: QueryInput,
): Promise<{ data: T[]; total?: number }> {
  const definition = registry.get(input.entity)
  if (!definition) {
    throw new CommerceNotFoundError(
      `No entity registered with name "${input.entity}".`,
    )
  }

  const service = services[definition.service] as Record<string, Function>

  // 1. Fetch primary records
  let rows: any[]
  let total: number | undefined

  if (input.id) {
    const result = await service[definition.getByIdMethod](input.id)
    rows = [result?.value ?? result]
  } else {
    const result = await service[definition.listMethod](
      input.filters ?? {},
      input.pagination,
    )
    rows = result?.value?.items ?? result?.value ?? result
    total = result?.value?.total ?? result?.meta?.total
  }

  // 2. Resolve includes
  if (input.include?.length) {
    await resolveIncludes(rows, input.include, definition, services, registry)
  }

  return { data: rows as T[], total }
}

async function resolveIncludes(
  rows: any[],
  includes: string[],
  definition: EntityDefinition,
  services: Record<string, unknown>,
  registry: QueryRegistry,
): Promise<void> {
  // Group includes by top-level segment
  const topLevel = new Map<string, string[]>()
  for (const path of includes) {
    const dot = path.indexOf(".")
    if (dot === -1) {
      if (!topLevel.has(path)) topLevel.set(path, [])
    } else {
      const parent = path.substring(0, dot)
      const child = path.substring(dot + 1)
      topLevel.set(parent, [...(topLevel.get(parent) ?? []), child])
    }
  }

  for (const [relationName, nestedIncludes] of topLevel) {
    const relation = definition.relations[relationName]
    if (!relation) continue

    const targetService = services[relation.targetService] as Record<string, Function>
    if (!targetService) continue

    // Collect foreign key values (deduplicated)
    const ids = [
      ...new Set(rows.map(r => r[relation.foreignKey]).filter(Boolean)),
    ]
    if (ids.length === 0) continue

    // One batched query
    const relatedResult = await targetService[relation.batchMethod](ids)
    const relatedRows: any[] = relatedResult?.value ?? relatedResult

    // Build lookup
    const map = new Map<string, any>()
    for (const related of relatedRows) {
      if (relation.isList) {
        const key = related[relation.foreignKey]
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(related)
      } else {
        map.set(related.id, related)
      }
    }

    // Attach
    for (const row of rows) {
      const fkValue = row[relation.foreignKey]
      if (!fkValue) continue
      row[relation.attachAs] = map.get(fkValue) ?? (relation.isList ? [] : null)
    }

    // Resolve nested includes
    if (nestedIncludes.length > 0) {
      const targetDef = registry.get(relation.targetService)
      if (targetDef) {
        const nestedRows = relation.isList
          ? rows.flatMap(r => r[relation.attachAs] ?? [])
          : rows.map(r => r[relation.attachAs]).filter(Boolean)
        await resolveIncludes(
          nestedRows, nestedIncludes, targetDef, services, registry,
        )
      }
    }
  }
}
```

### 14.5 Usage

Before:

```typescript
app.get("/orders/:id", async (c) => {
  const orderResult = await services.orders.getById(id)
  const customerResult = await services.customers.getByUserId(orderResult.value.customerId)
  const paymentResult = await services.payments.getByOrderId(id)
  return c.json({
    ...orderResult.value,
    customer: customerResult.ok ? customerResult.value : null,
    payment: paymentResult.ok ? paymentResult.value : null,
  })
})
```

After:

```typescript
app.get("/orders/:id", async (c) => {
  const result = await kernel.query({
    entity: "order",
    id: c.req.param("id"),
    include: ["customer", "payment", "lineItems"],
  })
  if (result.data.length === 0) return c.json({ error: "Not found" }, 404)
  return c.json({ order: result.data[0] })
})
```

---

## 15. Part 13 -- Type Augmentation

### 15.1 The problem

Types are inferred from Drizzle schemas via `$inferSelect` and `$inferInsert`. This works within the core. But plugin authors who want to reference `Order` or `Product` must import from specific schema modules. There is no centralized type map that plugins can augment.

### 15.2 Solution

Define an augmentable interface map:

```typescript
// packages/core/src/types/commerce-types.ts

export interface CommerceModuleTypes {
  Product: typeof import("../modules/catalog/schema").products.$inferSelect
  Order: typeof import("../modules/orders/schema").orders.$inferSelect
  Cart: typeof import("../modules/cart/schema").carts.$inferSelect
  Customer: typeof import("../modules/customers/schema").customers.$inferSelect
  InventoryLevel: typeof import("../modules/inventory/schema").inventoryLevels.$inferSelect
}
```

Plugins augment via TypeScript module augmentation:

```typescript
// my-plugin/src/types.ts
declare module "@unifiedcommerce/core" {
  interface CommerceModuleTypes {
    LoyaltyPoints: {
      id: string
      customerId: string
      points: number
      tier: "bronze" | "silver" | "gold"
    }
  }
}
```

This gives plugin authors a stable type reference without importing internal schema modules. It also enables the Local API and query composition layer to be generically typed against `CommerceModuleTypes`.

---

## 16. Adoption Path

The thirteen parts are ordered by dependency and priority. Here is the implementation sequence:

### Wave 1: Safety (no schema changes, pure TypeScript)

| Part | Item | Effort | Dependency |
|------|------|--------|------------|
| 1 | Compensation Chains | Low | None |
| 3 | Repository Factory | Medium | None |
| 4 | Access Composition | Low | None |

These three are independent of each other and can be built in parallel. They require no database migrations. They are pure TypeScript additions to the kernel.

### Wave 2: Schema additions (single migration)

| Part | Item | Effort | Dependency |
|------|------|--------|------------|
| 2 | Inventory Concurrency | Medium | Part 1 (compensation) |
| 5 | Hook Context Enrichment | Low | None |
| 8 | Audit Log | Medium | Part 5 (requestId on context) |
| 11 | Guest Cart | Medium | None |

Parts 2, 8, and 11 each add database tables or columns. They should ship in a single migration. Part 5 is a non-breaking type extension.

### Wave 3: Infrastructure

| Part | Item | Effort | Dependency |
|------|------|--------|------------|
| 6 | Database-Backed Job Queue | Medium | Part 5 (jobs on context) |
| 7 | Local API | Medium | Part 5 (origin field) |

Parts 6 and 7 should be designed together. The Local API needs the jobs adapter available so that local operations can enqueue jobs.

### Wave 4: Extension mechanisms

| Part | Item | Effort | Dependency |
|------|------|--------|------------|
| 9 | Plugin Config Transform + extraColumns | Medium | Part 3 (factory) |
| 10 | CartItemMatcher + PaymentAdapter extraColumns | Low | Part 9 (extraColumns pattern) |
| 12 | Query Composition Layer | Medium | Part 3 (factory) |
| 13 | Type Augmentation | Low | None |

These are additive features that build on the foundation laid in Waves 1-3.

### Estimated total

13 parts across 4 waves. Each wave can be completed and shipped independently. No wave requires rolling back a previous wave. The engine remains functional between waves -- each wave is additive.

---

## 17. What We Keep As-Is

For completeness, these are architectural decisions in the current engine that should NOT change. They are equal to or ahead of both Medusa and PayloadCMS:

**TxContext / withTransaction pattern.** PayloadCMS attaches the transaction ID to `req` and passes it through. Our explicit `TxContext` object is more portable and easier to reason about in serverless contexts. Keep it.

**Result<T, E> over exceptions.** PayloadCMS throws exceptions throughout its codebase. Our Result type makes the error surface explicit. This is safer and produces better TypeScript inference. Keep it.

**Hono-based HTTP layer.** PayloadCMS is tied to Next.js. Medusa uses Express. Hono runs on Bun, Node, Cloudflare Workers, Deno, and AWS Lambda with zero adapter code. This is genuine serverless portability. Keep it.

**In-memory repository testing.** PayloadCMS uses DI and a real database for tests. Our in-memory repositories allow tests to run without any database. This is faster and more portable. Keep it. The `createInMemoryRepository` factory (Part 3) makes this even easier.

**MCP tool system.** PayloadCMS has a minimal `plugin-mcp`. Our first-class MCP integration with context enrichment and tool manifests is a differentiator. Keep and extend it.

**Three-tier hook system.** The BeforeHook/AfterHook pattern with operation-scoped registration is well-designed. The changes in this RFC (context enrichment, compensation chains) extend the hook system without altering its core semantics.

**Adapter pattern for external services.** Payment, storage, tax, search -- all adapter-backed with no vendor coupling. This is the correct architecture. This RFC adds `extraColumns` to payment adapters and a `DrizzleJobsAdapter` for the job queue, both of which follow the established adapter pattern.

---

This document is the complete engineering specification for hardening @unifiedcommerce/core. Every pattern has been verified against production-grade implementations in Medusa v2 and PayloadCMS v3. Every blueprint is ready for implementation. The adoption path ensures the engine remains functional and shippable at every stage.
