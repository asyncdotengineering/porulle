# RFC-003: Core Hardening

**Status**: Draft
**Author**: Engineering
**Created**: March 2026
**Depends on**: RFC-001 (Plugin System), RFC-002 (Repository Pattern)

---

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Part 1 -- Compensation Chains](#3-part-1----compensation-chains)
4. [Part 2 -- Inventory Concurrency Safety](#4-part-2----inventory-concurrency-safety)
5. [Part 3 -- Repository and Service Factory](#5-part-3----repository-and-service-factory)
6. [Part 4 -- Background Jobs Adapter](#6-part-4----background-jobs-adapter)
7. [Part 5 -- Query Composition Layer](#7-part-5----query-composition-layer)
8. [Adoption Path](#8-adoption-path)
9. [Open Questions](#9-open-questions)

---

## 1. Summary

This RFC proposes five targeted changes to the core that address real production failure modes and developer experience gaps discovered through comparative analysis with mature commerce platforms. None of these changes alter the fundamental architecture of @unifiedcommerce/core. They extend what is already here.

The five changes are:

- **Compensation Chains**: A lightweight mechanism to declare rollback logic alongside forward logic, so multi-step operations like checkout can reverse completed work when a later step fails. This runs entirely within a single request. There is no Redis, no distributed state, no worker process.
- **Inventory Concurrency Safety**: Add `SELECT FOR UPDATE` locking at the database level and a `version` column for optimistic concurrency, so two simultaneous checkouts cannot both successfully reserve the last unit.
- **Repository and Service Factory**: A factory function that derives standard CRUD operations from a Drizzle table schema, eliminating the ~80% of repository code that is identical across every module.
- **Background Jobs Adapter**: An optional, adapter-backed job queue that plugins can use to defer work that must not block the HTTP response. No event bus. No pub-sub. Just a typed `ctx.jobs.enqueue(name, payload)` call that plugins can wire to Inngest, pg-boss, Cloudflare Queues, or any other queue via an adapter.
- **Query Composition Layer**: A `kernel.query({ entity, include, filters, pagination })` API that resolves multiple related entities in a fixed number of batched database queries, eliminating the manual multi-service data assembly that API route handlers currently do.

---

## 2. Motivation

### 2.1 The checkout pipeline can corrupt data today

Read `packages/core/src/hooks/checkout.ts`. The checkout flow is implemented as a series of `BeforeHook` and `AfterHook` functions registered in sequence. This works correctly when every step succeeds. The problem is what happens when a later step fails after an earlier destructive step has already committed.

The specific failure path today:

```
BeforeHooks (validation, pricing, tax, shipping, authorize payment) -- all run and succeed
  -> order.create() runs and succeeds -- order row written to DB
AfterHooks run in sequence:
  -> capturePayment()     -- charges the customer's card, succeeds
  -> reserveInventory()   -- FAILS (warehouse unreachable, DB error, anything)
```

At this point, the customer has been charged and an order exists, but inventory has not been reserved. The inventory oversell counter has not moved. The system is now in an inconsistent state with no automated path to recovery. The only fix is manual intervention.

This is not a theoretical edge case. Payment processors respond in milliseconds. Inventory reservation involves a database write. Any transient fault between those two steps produces this outcome.

The hook system does not have a compensation concept. `AfterHook` functions can run side effects, but there is no way to declare "if this hook fails, undo what the previous hook did." We need one.

### 2.2 Inventory reservation is not safe under concurrency

The `inventory_levels` table stores `quantity_on_hand` and `quantity_reserved`. The reservation path in `InventoryService` is:

```
1. Read the current level row
2. Check that quantity_on_hand - quantity_reserved >= requested quantity
3. Write an updated quantity_reserved value
```

Steps 1 and 3 are separate database operations with no isolation guarantee between them. Under concurrent load, two requests can both execute step 1, both see sufficient stock, and both execute step 3 -- each writing their own reservation against the same inventory. The result is that more units are reserved than physically exist. This is inventory oversell.

### 2.3 Every repository module is mostly the same code

Open any two repository files back-to-back. `InventoryRepository`, `CatalogRepository`, `OrderRepository`. They all contain `findById`, `findMany`, `create`, `update`, `delete` methods. Each one calls `this.getDb(ctx)`, builds a Drizzle query, and returns a row or array. The implementations are structurally identical. The only differences are the table reference and the column names.

This pattern means that adding a new module requires writing approximately 200 lines of repository code before any domain logic exists. It also means that when we improve the pattern -- say, adding soft-delete support or paginated list queries -- we have to apply that change to 15+ files manually.

### 2.4 Plugins have no safe way to defer work

Some plugin operations must not block the HTTP response. Indexing a product into Algolia after a catalog update can take 300ms and should not add that latency to the `POST /catalog/products` response. Sending an order confirmation email should not fail the checkout if the mail provider is temporarily unreachable.

The current hook system offers no mechanism for deferred work. A hook either runs synchronously (blocking the response) or it fires without awaiting and the result is discarded. The "fire without awaiting" approach is actively unsafe in serverless environments because the function invocation may terminate before the background work completes.

What is needed is a way for plugins to say "do this later" and have the runtime understand what "later" means in the deployment context.

### 2.5 Assembling related data requires manual multi-service calls

A typical API route that returns an order with its customer, line items, and payment status today:

```typescript
const orderResult = await services.orders.getById(id)
if (!orderResult.ok) { ... }

const customerResult = await services.customers.getByUserId(orderResult.value.customerId)
const paymentResult = await services.payments.getByOrderId(id)

return {
  ...orderResult.value,
  customer: customerResult.ok ? customerResult.value : null,
  payment: paymentResult.ok ? paymentResult.value : null,
}
```

This pattern repeats in every route that needs related data. It is verbose. It does not batch, so three sequential database round-trips become unavoidable. It puts data-assembly logic into HTTP route handlers, which is the wrong layer for that work. And when a consumer wants a slightly different set of related data, a new route or a new service method must be written.

---

## 3. Part 1 -- Compensation Chains

### 3.1 Problem statement

We need a way to run a sequence of steps where each step can declare what should happen to undo its work if a later step in the same sequence fails. All of this must complete within a single HTTP request. There must be no external state, no Redis, no persistent workflow engine.

This is a synchronous compensation pattern, not a distributed saga. It is simple enough that it can be expressed in roughly 60 lines of TypeScript.

### 3.2 What a compensation chain is not

To be clear about scope: this is not a workflow engine. It does not persist state across requests. It does not support async steps that resume after a delay. It does not integrate with AWS Step Functions or any external orchestrator. Those tools are appropriate when work genuinely spans multiple invocations. For a checkout that runs in a single HTTP request, they are unnecessary complexity.

### 3.3 Pseudo-code

```
define a Step as:
  - an id (string, for logging)
  - a run function that takes (input, context) and returns a result
  - an optional compensate function that takes (the value returned by run, context) and returns void

define a CompensationChain as a list of Steps

to execute a CompensationChain:
  create an empty stack of completed-step records
  for each step in the list:
    call step.run(current-input, context)
    if run returns an error:
      for each completed step in the stack, in reverse order:
        call that step's compensate function with (the value it returned, context)
      return the error
    else:
      push { step, returnedValue } onto the stack
      pass the output to the next step if the chain is sequential
  return the final result

the compensate function for each step is responsible for undoing exactly what that step did,
using the value it received as the first argument (which is the value run returned for that step)
```

### 3.4 Type definitions

```typescript
// packages/core/src/kernel/compensation/types.ts

import type { TxContext } from "../database/tx-context"
import type { HookContext } from "../hooks/types"
import type { Result } from "../result"

/**
 * CompensationContext is passed to both the run and compensate functions.
 * It carries the transaction context and the broader hook context so steps
 * have access to services, the actor, and the logger.
 */
export interface CompensationContext {
  tx: TxContext | null
  hook: HookContext
}

/**
 * A Step is the atomic unit of a compensation chain.
 *
 * TInput is the type of the data the step receives.
 * TOutput is the type of the value the step produces -- this same value
 * is passed to the compensate function, so it should contain everything
 * the compensate function needs to reverse the work.
 */
export interface Step<TInput, TOutput> {
  id: string
  run: (input: TInput, ctx: CompensationContext) => Promise<Result<TOutput>>
  compensate?: (output: TOutput, ctx: CompensationContext) => Promise<void>
}

/**
 * A record of a step that has successfully run, held on the compensation stack
 * so we know what to call if a later step fails.
 */
interface CompletedStep<TOutput = unknown> {
  step: Step<unknown, TOutput>
  output: TOutput
}
```

### 3.5 Executor implementation

```typescript
// packages/core/src/kernel/compensation/executor.ts

import type { CompensationContext, Step } from "./types"
import type { Result } from "../result"
import { Err } from "../result"

/**
 * runCompensationChain executes a list of steps in order.
 *
 * Steps do not pass data between each other in this design. Each step
 * receives the same original input. Steps mutate the input object if they
 * need to enrich it -- the same pattern already established by BeforeHooks.
 *
 * If any step fails, all previously completed steps are compensated in
 * reverse order before the error is returned. Compensation failures are
 * logged but do not override the original error -- the caller receives
 * the error from the step that originally failed.
 *
 * @param steps  Ordered list of steps to execute.
 * @param input  The shared input object. Steps may mutate this.
 * @param ctx    The compensation context (transaction + hook context).
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
        `Compensation chain failed at step "${step.id}". Running ${completed.length} compensation(s).`,
        { error: result.error },
      )

      // Compensate in reverse order
      for (const done of [...completed].reverse()) {
        if (!done.step.compensate) continue
        try {
          await done.step.compensate(done.output, ctx)
          ctx.hook.logger.info(`Compensated step "${done.step.id}"`)
        } catch (compensateError) {
          // Log but do not swallow the original error.
          // A failed compensation is a separate concern -- it should be
          // handled by alerting and manual review, not by masking the cause.
          ctx.hook.logger.error(
            `Compensation for step "${done.step.id}" itself failed. Manual review required.`,
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

### 3.6 Rewriting the checkout pipeline

The current checkout pipeline uses BeforeHooks for validation and data enrichment and AfterHooks for side effects (capture payment, reserve inventory). The problem is specifically in the AfterHooks: `capturePayment` and `reserveInventory` run sequentially with no compensation link between them.

The fix is to move the write-side operations (authorize, reserve, capture) into a compensation chain that is invoked from a single AfterHook. The read-side BeforeHooks (validate cart, resolve prices, calculate tax, calculate shipping) remain exactly as they are -- they do not need compensation because they only read data and enrich the `CheckoutData` object.

```typescript
// packages/core/src/hooks/checkout-completion.ts

import type { Step } from "../kernel/compensation/types"
import type { CheckoutData } from "./checkout"
import { Ok, Err } from "../kernel/result"
import { CommerceValidationError } from "../kernel/errors"

/**
 * Step 1: Reserve inventory.
 *
 * The output is the list of reservations created. The compensate function
 * releases all of them by their order reference.
 */
export const reserveInventoryStep: Step<CheckoutData, Array<{ entityId: string; variantId?: string; quantity: number; orderId: string }>> = {
  id: "reserve-inventory",

  async run(data, ctx) {
    const inventory = ctx.hook.services.inventory as {
      reserve(input: {
        entityId: string
        variantId?: string
        quantity: number
        orderId: string
        performedBy: string
      }): Promise<{ ok: boolean; error?: { message: string } }>
    }

    const reservations: Array<{ entityId: string; variantId?: string; quantity: number; orderId: string }> = []

    for (const item of data.lineItems) {
      const result = await inventory.reserve({
        entityId: item.entityId,
        variantId: item.variantId,
        quantity: item.quantity,
        orderId: data.checkoutId,
        performedBy: ctx.hook.actor?.userId ?? "system",
      })

      if (!result.ok) {
        return Err(new CommerceValidationError(
          `Inventory reservation failed for ${item.title ?? item.entityId}: ${result.error?.message ?? "unknown error"}`,
        ))
      }

      reservations.push({
        entityId: item.entityId,
        variantId: item.variantId,
        quantity: item.quantity,
        orderId: data.checkoutId,
      })
    }

    return Ok(reservations)
  },

  async compensate(reservations, ctx) {
    const inventory = ctx.hook.services.inventory as {
      release(input: {
        entityId: string
        variantId?: string
        quantity: number
        orderId: string
        performedBy: string
      }): Promise<unknown>
    }

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
 * The output is the captured payment intent ID. The compensate function
 * issues a full refund.
 */
export const capturePaymentStep: Step<CheckoutData, { paymentIntentId: string }> = {
  id: "capture-payment",

  async run(data, ctx) {
    const payments = ctx.hook.services.payments as {
      capture(paymentIntentId: string): Promise<{ ok: boolean; error?: { message: string } }>
    }

    if (!data.paymentIntentId) {
      return Err(new CommerceValidationError("No authorized payment intent to capture."))
    }

    const result = await payments.capture(data.paymentIntentId)

    if (!result.ok) {
      return Err(new CommerceValidationError(
        `Payment capture failed: ${result.error?.message ?? "unknown error"}`,
      ))
    }

    return Ok({ paymentIntentId: data.paymentIntentId })
  },

  async compensate({ paymentIntentId }, ctx) {
    const payments = ctx.hook.services.payments as {
      refund(input: { paymentIntentId: string; reason: string }): Promise<unknown>
    }

    await payments.refund({
      paymentIntentId,
      reason: "Checkout compensation: downstream step failed after payment capture",
    })
  },
}
```

The AfterHook that drives checkout completion then becomes:

```typescript
// In packages/core/src/hooks/checkout.ts, replacing the separate
// capturePayment and reserveInventory AfterHooks:

import { runCompensationChain } from "../kernel/compensation/executor"
import { reserveInventoryStep, capturePaymentStep } from "./checkout-completion"

export const completeCheckout: AfterHook<Order> = async ({ result, context }) => {
  // Build the CheckoutData view from the created order.
  // result is the Order just written to the database.
  const checkoutData: CheckoutData = {
    checkoutId: result.id,
    cartId: result.cartId,
    customerId: result.customerId,
    currency: result.currency,
    paymentMethodId: result.paymentMethodId,
    lineItems: result.lineItems,
    subtotal: result.subtotal,
    discountTotal: result.discountTotal,
    taxTotal: result.taxTotal,
    shippingTotal: result.shippingTotal,
    total: result.grandTotal,
    paymentIntentId: context.metadata.paymentIntentId as string | undefined,
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
    // The chain has already compensated every completed step.
    // Mark the order as failed so no further processing occurs.
    const orders = context.services.orders as {
      updateStatus(id: string, status: "failed", reason: string): Promise<unknown>
    }
    await orders.updateStatus(result.id, "failed", chainResult.error.message)
    throw chainResult.error
  }
}
```

### 3.7 Plugin integration

Plugins that contribute steps to the checkout chain do so via the hook system, not by modifying core files. The plugin registers a hook that wraps the existing completion chain with additional steps:

```typescript
defineCommercePlugin({
  id: "erp-sync",
  hooks: (ctx) => [{
    key: "orders.afterCreate",
    handler: async ({ result, context }) => {
      // The plugin adds its own step to a local chain if needed,
      // or it simply runs its logic here knowing the core chain
      // has already completed successfully (order exists, payment captured,
      // inventory reserved) before this hook fires.
      await ctx.services.erp.syncOrder(result)
    },
  }],
})
```

For cases where a plugin needs to add a step *inside* the compensation chain (for example, a fraud check that should trigger payment refund if it fails), we expose a `steps` registration on the plugin manifest:

```typescript
// Future extension to CommercePluginManifest (out of scope for this RFC,
// noted here for architectural awareness):
checkoutSteps?: (ctx: PluginRouteContext) => {
  position: "before:capture-payment" | "after:reserve-inventory" | string
  step: Step<CheckoutData, unknown>
}[]
```

This is not implemented in this RFC. The core chain covers the required baseline.

---

## 4. Part 2 -- Inventory Concurrency Safety

### 4.1 Problem statement

The `inventory_levels` table has no concurrency control. A read-modify-write operation spanning two separate database calls (read level, then write updated reserved quantity) is not safe when two requests execute it simultaneously against the same row.

We need row-level locking for the reservation path so that once a request starts reserving a specific inventory row, no other request can read or write that row until the first request either commits or rolls back.

### 4.2 The two approaches and why we choose PostgreSQL-native locking

**Option A: Optimistic concurrency** adds a `version` integer column to `inventory_levels`. The UPDATE statement includes a `WHERE version = :current_version` clause. If another request has modified the row since this request read it, zero rows are updated and the caller retries. This is lock-free and works well under low-to-moderate contention.

**Option B: Pessimistic locking** uses `SELECT ... FOR UPDATE`, which is a PostgreSQL instruction to lock the selected rows for the duration of the current transaction. Any other transaction that tries to select the same rows with `FOR UPDATE` will wait until the first transaction releases them. This serializes concurrent reservations but holds a database lock for the duration of the operation.

For inventory reservation, optimistic concurrency produces retry loops under even moderate traffic (two requests for the last unit both fail and must retry, and one of them will fail again). Pessimistic locking with `SELECT FOR UPDATE` is the correct choice here. The lock is held only for the duration of a single `reserve()` call, which is a microsecond-level database operation. There is no risk of lock starvation in normal commerce traffic patterns.

We still add a `version` column because it is cheap and it gives us a change detection mechanism that is useful outside of locking (for cache invalidation, ETags, etc.).

### 4.3 Schema change

```typescript
// packages/core/src/modules/inventory/schema.ts
// Changes to inventoryLevels table only:

export const inventoryLevels = pgTable(
  "inventory_levels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .references(() => sellableEntities.id, { onDelete: "cascade" })
      .notNull(),
    variantId: uuid("variant_id").references(() => variants.id, {
      onDelete: "cascade",
    }),
    warehouseId: uuid("warehouse_id")
      .references(() => warehouses.id)
      .notNull(),
    quantityOnHand: integer("quantity_on_hand").notNull().default(0),
    quantityReserved: integer("quantity_reserved").notNull().default(0),
    quantityIncoming: integer("quantity_incoming").notNull().default(0),
    unitCost: integer("unit_cost"),
    reorderThreshold: integer("reorder_threshold"),
    reorderQuantity: integer("reorder_quantity"),
    lastRestockedAt: timestamp("last_restocked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // NEW: version column for optimistic concurrency and cache invalidation.
    version: integer("version").notNull().default(0),
  },
  (table) => ({
    entityVariantWarehouseIdx: index("idx_inventory_entity_variant_warehouse").on(
      table.entityId,
      table.variantId,
      table.warehouseId,
    ),
  }),
)
```

### 4.4 Pseudo-code for the locked reservation

```
to reserve inventory for a line item:
  BEGIN TRANSACTION (if not already in one)

  SELECT the inventory_levels row(s) matching entityId + variantId + warehouseId
  using FOR UPDATE -- this locks the rows

  if no row found: return error "no inventory record for this entity"

  compute available = quantity_on_hand - quantity_reserved
  if available < requested quantity: return error "insufficient stock"

  UPDATE inventory_levels
    SET quantity_reserved = quantity_reserved + requested_quantity,
        updated_at = now(),
        version = version + 1
    WHERE id = :row_id

  INSERT into inventory_movements (type=reservation, ...)

  COMMIT
  return success
```

### 4.5 Repository implementation

The existing `InventoryRepository.findLevelsByEntityAndVariant` method returns rows after a plain `SELECT`. We need a variant that issues `SELECT ... FOR UPDATE`.

Drizzle ORM supports `FOR UPDATE` via the `.for("update")` clause on a select query.

```typescript
// packages/core/src/modules/inventory/repository/index.ts
// New method alongside existing findLevelsByEntityAndVariant:

/**
 * findLevelForUpdate issues a SELECT ... FOR UPDATE on the inventory_levels row
 * matching the given entity and variant within the provided transaction context.
 *
 * This method MUST be called inside an active transaction (ctx.tx must be set).
 * Calling it outside a transaction provides no locking guarantee.
 *
 * The method returns the first matching row locked for update, or undefined if
 * no level record exists for the given entity/variant combination.
 */
async findLevelForUpdate(
  entityId: string,
  variantId: string | null,
  warehouseId: string,
  ctx: TxContext,  // Required, not optional -- this is a deliberate API constraint
): Promise<InventoryLevel | undefined> {
  const db = this.getDb(ctx) // ctx.tx is the transaction connection

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
 * reserveWithLock performs a read-modify-write under a row-level lock.
 *
 * This is the only correct method to use when modifying quantity_reserved
 * in a concurrent environment. It must be called inside withTransaction.
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

The `InventoryService.reserve` method must now use `withTransaction` and call `reserveWithLock` instead of the current read-then-write pattern.

```typescript
// packages/core/src/modules/inventory/service.ts
// Replace the existing reserve() implementation:

async reserve(input: InventoryReserveInput, ctx?: TxContext): Promise<Result<void>> {
  try {
    // We always need a transaction for reservation to get locking semantics.
    // If the caller provided one (e.g., from a compensation chain), we reuse it.
    // If not, we start a new one.
    const doReserve = async (txCtx: TxContext): Promise<Result<void>> => {
      const warehouseId = input.warehouseId ?? await this.pickWarehouse(txCtx)

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
          performedBy: input.performedBy ?? "system",
        },
        txCtx,
      )

      return Ok(undefined)
    }

    if (ctx?.tx) {
      return doReserve(ctx)
    }

    // No existing transaction -- start one.
    return await withTransaction(this.db, { actor: null }, doReserve)
  } catch (err) {
    return Err(toCommerceError(err))
  }
}
```

### 4.7 Migration

```typescript
// A new Drizzle migration adding the version column:
// ALTER TABLE inventory_levels ADD COLUMN version integer NOT NULL DEFAULT 0;
//
// This is backward compatible. Existing rows receive version = 0.
// No application code breaks because the column has a default.
// After migration, all writes via reserveWithLock increment the version.
```

---

## 5. Part 3 -- Repository and Service Factory

### 5.1 Problem statement

Every Drizzle repository in the codebase follows the same pattern. There is a private `getDb(ctx)` method that returns either the transaction or the base database. There are `findById`, `findMany`, `create`, `update`, `delete`, and `softDelete` methods. Each one builds a Drizzle query against its table.

This is approximately 150-200 lines of code per module before any domain-specific logic begins. With 15+ modules, roughly 2,000+ lines of the codebase are pure structural repetition. When we want to add a capability (for example, soft delete support or cursor-based pagination) we apply the same change 15+ times.

The fix is a `createRepository` factory that derives the standard methods from a Drizzle table schema and returns a typed repository instance. Domain-specific methods are added on top by extending the returned class or by using the repository directly alongside custom queries.

### 5.2 What the factory must produce

Given a Drizzle table schema object, the factory should produce an object with:

- `findById(id, ctx?)` -- returns `Row | undefined`
- `findMany(filters?, options?, ctx?)` -- returns `Row[]` with `where`, `orderBy`, `limit`, `offset` support
- `findAndCount(filters?, options?, ctx?)` -- returns `{ rows: Row[], total: number }`
- `create(data, ctx?)` -- inserts one row and returns it
- `createMany(data[], ctx?)` -- inserts multiple rows and returns them
- `update(id, data, ctx?)` -- updates by id and returns the updated row
- `delete(id, ctx?)` -- hard deletes by id
- `softDelete(id, ctx?)` -- sets `deleted_at` to now (only if the table has a `deleted_at` column)
- `restore(id, ctx?)` -- clears `deleted_at` (only if the table has a `deleted_at` column)

The factory is typed. The return type of every method is derived from the table schema. No type casting is required at the call site.

### 5.3 Pseudo-code

```
function createRepository(table, db):
  infer Row type from table.$inferSelect
  infer Insert type from table.$inferInsert

  determine whether the table has a deleted_at column
  determine whether the table has an id column (it must)

  return an object where:

  findById(id, ctx):
    query = SELECT * FROM table WHERE id = id
    if table has deleted_at: AND deleted_at IS NULL
    return first row or undefined

  findMany(filters, options, ctx):
    query = SELECT * FROM table
    if table has deleted_at AND options.withDeleted is not true: AND deleted_at IS NULL
    apply each filter in filters as WHERE clauses using eq()
    apply options.orderBy if provided
    apply options.limit and options.offset if provided
    return rows

  findAndCount(filters, options, ctx):
    run findMany to get rows
    run SELECT COUNT(*) with same filters (no limit/offset)
    return { rows, total }

  create(data, ctx):
    INSERT INTO table VALUES (data) RETURNING *
    return first row

  createMany(data, ctx):
    INSERT INTO table VALUES (...data) RETURNING *
    return all rows

  update(id, data, ctx):
    UPDATE table SET data WHERE id = id RETURNING *
    return first row or throw if not found

  delete(id, ctx):
    DELETE FROM table WHERE id = id

  softDelete(id, ctx):
    if table has no deleted_at column: throw configuration error
    UPDATE table SET deleted_at = now() WHERE id = id

  restore(id, ctx):
    if table has no deleted_at column: throw configuration error
    UPDATE table SET deleted_at = null WHERE id = id
```

### 5.4 Type-level design

The tricky part of this implementation is the TypeScript types. We need the return types to be `Row` (inferred from the table) and the insert types to be `Insert` (also inferred). We also need the `softDelete` and `restore` methods to only appear on the return type when the table actually has a `deleted_at` column, so they cannot be called on tables that do not support soft deletion.

```typescript
// packages/core/src/kernel/factory/repository-factory.ts

import {
  eq,
  and,
  isNull,
  sql,
  type SQL,
  type InferSelectModel,
  type InferInsertModel,
  type PgTableWithColumns,
  type TableConfig,
} from "drizzle-orm"
import type { TxContext } from "../database/tx-context"
import type { DrizzleDatabase, DbOrTx } from "../database/drizzle-db"
import { CommerceNotFoundError } from "../errors"

/**
 * Filters is a partial Record of the Row type.
 * Only columns present in the table can be used as filters.
 */
export type Filters<TRow> = Partial<TRow>

export interface FindOptions {
  limit?: number
  offset?: number
  orderBy?: Array<{ column: string; direction: "asc" | "desc" }>
  withDeleted?: boolean
}

/**
 * BaseRepository is the return type of createRepository for tables without
 * a deleted_at column.
 */
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

/**
 * SoftDeletableRepository extends BaseRepository with soft-delete methods.
 * createRepository returns this type when the table schema includes a deleted_at column.
 */
export interface SoftDeletableRepository<TRow, TInsert> extends BaseRepository<TRow, TInsert> {
  softDelete(id: string, ctx?: TxContext): Promise<void>
  restore(id: string, ctx?: TxContext): Promise<TRow>
}

/**
 * HasDeletedAt is a type guard helper. If a table has a deleted_at column,
 * the repository returned will include soft delete methods.
 */
type HasDeletedAt<T extends TableConfig> = "deleted_at" extends keyof T["columns"] ? true : false

/**
 * RepositoryFor returns the correct repository interface type based on whether
 * the table has a deleted_at column.
 */
export type RepositoryFor<T extends PgTableWithColumns<any>> =
  HasDeletedAt<T["_"]["config"]> extends true
    ? SoftDeletableRepository<InferSelectModel<T>, InferInsertModel<T>>
    : BaseRepository<InferSelectModel<T>, InferInsertModel<T>>

/**
 * createRepository is the factory function.
 *
 * Usage:
 *
 *   const ordersRepo = createRepository(schema.orders, db)
 *   const order = await ordersRepo.findById("order_123")
 *   const allOrders = await ordersRepo.findMany({ status: "pending" }, { limit: 50 })
 *
 * To add domain-specific methods, extend the factory output:
 *
 *   class OrderRepository {
 *     private base = createRepository(schema.orders, db)
 *
 *     // Delegate standard methods
 *     findById = this.base.findById.bind(this.base)
 *     findMany = this.base.findMany.bind(this.base)
 *     create = this.base.create.bind(this.base)
 *     // ... etc
 *
 *     // Domain-specific method
 *     async findByCustomer(customerId: string, ctx?: TxContext) {
 *       return this.base.findMany({ customerId }, {}, ctx)
 *     }
 *   }
 */
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
    const softRepo = repo as SoftDeletableRepository<InferSelectModel<T>, InferInsertModel<T>>

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

### 5.5 What this replaces

Modules that have no domain-specific repository logic can delete their entire `repository/index.ts` file and use the factory directly from the service constructor:

```typescript
// Before: 200 lines in packages/core/src/modules/promotions/repository/index.ts
// After:

import { createRepository } from "../../kernel/factory/repository-factory"
import { promotions, promotionRules } from "./schema"

// In PromotionsService constructor:
this.promotionRepo = createRepository(schema.promotions, db)
this.ruleRepo = createRepository(schema.promotionRules, db)
```

Modules that have domain-specific queries keep their repository class but use the factory for the standard operations:

```typescript
// packages/core/src/modules/inventory/repository/index.ts
// The domain-specific methods (reserveWithLock, findLevelForUpdate, etc.)
// remain. Standard CRUD is delegated to the factory.

export class InventoryRepository {
  private levelBase = createRepository(schema.inventoryLevels, db)
  private warehouseBase = createRepository(schema.warehouses, db)

  // Delegate standard methods
  findWarehouseById = this.warehouseBase.findById.bind(this.warehouseBase)
  findAllWarehouses(ctx?: TxContext) {
    return this.warehouseBase.findMany(undefined, undefined, ctx)
  }
  createWarehouse = this.warehouseBase.create.bind(this.warehouseBase)
  updateWarehouse(id: string, data: any, ctx?: TxContext) {
    return this.warehouseBase.update(id, data, ctx)
  }

  // Domain-specific methods remain here
  async findLevelForUpdate(entityId, variantId, warehouseId, ctx) { ... }
  async reserveWithLock(entityId, variantId, warehouseId, quantity, ctx) { ... }
}
```

### 5.6 In-memory counterpart

The existing in-memory repository pattern (used for tests) can be factory-derived in the same way:

```typescript
// packages/core/src/kernel/factory/in-memory-repository-factory.ts

export function createInMemoryRepository<TRow extends { id: string }, TInsert>(
): BaseRepository<TRow, TInsert> & { _store: Map<string, TRow> } {
  const store = new Map<string, TRow>()

  return {
    _store: store,
    async findById(id) { return store.get(id) },
    async findMany(filters) {
      const rows = Array.from(store.values())
      if (!filters) return rows
      return rows.filter(row =>
        Object.entries(filters).every(([k, v]) => v === undefined || (row as any)[k] === v),
      )
    },
    async findAndCount(filters, options) {
      const rows = await this.findMany(filters)
      const paginated = options?.limit ? rows.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit) : rows
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

This means test repositories no longer need to be written by hand either.

---

## 6. Part 4 -- Background Jobs Adapter

### 6.1 Design decision: no event bus

This design explicitly rejects a pub-sub event bus as a core primitive. The reasons are:

1. In serverless, an in-process event bus is not meaningful -- each function invocation is isolated and stateless. Listeners registered in invocation A do not exist in invocation B.
2. A cross-invocation event bus requires external infrastructure (Redis Pub/Sub, SQS, etc.), introducing vendor coupling that contradicts the "Zero Vendor Lock-In" ethos.
3. The hook system already provides synchronous, typed extension points for every operation. This covers 90% of what developers reach for an event bus to do.

The remaining 10% is background work: send an email after an order is placed, reindex a product after an update, notify an ERP system after fulfillment. For this, we introduce a `jobs` adapter that is completely optional.

The design is modelled closely on what PayloadCMS does: hooks for synchronous side effects, a job queue for deferred work. The job queue is an adapter -- null by default, wired to a real queue by the application developer if needed.

### 6.2 What the adapter interface looks like

```typescript
// packages/core/src/kernel/jobs/adapter.ts

/**
 * JobsAdapter is the interface that any background job queue implementation
 * must satisfy. The core does not implement this -- it defines only the contract.
 *
 * Implementations might wrap Inngest, pg-boss, Cloudflare Queues, BullMQ,
 * or any other queue. The application developer chooses.
 */
export interface JobsAdapter {
  /**
   * Enqueue schedules a job to run outside the current request.
   *
   * name:    The job type identifier. The queue implementation uses this to
   *          route the job to the correct handler.
   * payload: A serializable object passed to the handler. Must be JSON-safe.
   * options: Optional scheduling options (delay, queue name, etc.).
   *          The exact options depend on the adapter. The adapter may ignore
   *          options it does not support.
   */
  enqueue(
    name: string,
    payload: Record<string, unknown>,
    options?: JobEnqueueOptions,
  ): Promise<void>
}

export interface JobEnqueueOptions {
  /** Delay before the job runs, in milliseconds. */
  delayMs?: number
  /** Named queue to route the job into (for priority separation). */
  queue?: string
  /** Unique key -- if a job with this key is already queued, do not enqueue again. */
  deduplicationKey?: string
}

/**
 * NullJobsAdapter is the default. It does nothing.
 * When no jobs adapter is configured, enqueued jobs are simply dropped.
 * This keeps the API safe to call in all environments.
 */
export class NullJobsAdapter implements JobsAdapter {
  async enqueue(name: string) {
    // Intentionally empty. Callers should not need to check whether
    // a jobs adapter is configured before calling enqueue().
  }
}
```

### 6.3 Wiring the adapter into the kernel

The `CommerceConfig` gains an optional `jobs` property:

```typescript
// In packages/core/src/config/types.ts (additions only):

export interface CommerceConfig {
  // ... existing fields ...

  /**
   * jobs: An optional background job queue adapter.
   *
   * When not set, job enqueue calls are silently dropped (NullJobsAdapter).
   * Configure this in environments where background work is required.
   *
   * Example (with Inngest):
   *   import { InngestJobsAdapter } from "@unifiedcommerce/adapter-inngest"
   *   jobs: new InngestJobsAdapter({ eventKey: process.env.INNGEST_EVENT_KEY })
   */
  jobs?: JobsAdapter
}
```

The `HookContext` (already used by all hooks and compensation steps) gains a `jobs` property:

```typescript
// packages/core/src/kernel/hooks/types.ts (additions only):

export interface HookContext {
  actor: Actor | null
  tx: unknown
  logger: Logger
  services: ServiceContainer
  metadata: Record<string, unknown>
  /**
   * jobs is the background job queue adapter, if configured.
   * Always safe to call -- if no adapter is configured, enqueue is a no-op.
   */
  jobs: JobsAdapter
}
```

The kernel wires the adapter (or the null default) into the context at startup:

```typescript
// In packages/core/src/runtime/kernel.ts, when constructing HookContext:
const jobsAdapter = config.jobs ?? new NullJobsAdapter()

// Pass jobsAdapter into the HookContext factory used by all hooks and steps.
```

### 6.4 Plugin usage pattern

A plugin that sends order confirmation emails uses `AfterHook` + `ctx.hook.jobs.enqueue`:

```typescript
defineCommercePlugin({
  id: "order-notifications",
  hooks: (ctx) => [{
    key: "orders.afterCreate",
    handler: async ({ result, context }) => {
      // Synchronous side effect: fine for fast, low-risk operations.
      ctx.hooks.register("orders.afterCreate", async ({ result, context }) => {
        await context.jobs.enqueue("send-order-confirmation", {
          orderId: result.id,
          customerId: result.customerId,
          total: result.grandTotal,
          currency: result.currency,
        })
        // The HTTP response returns immediately.
        // The email sends when the queue processes the job.
      })
    },
  }],
})
```

The job handler itself is registered with the queue adapter outside of the plugin system -- it is specific to the queue implementation:

```typescript
// In the application's job handler setup (e.g., inngest/functions.ts):
// This is application-layer code, not core code.
inngest.createFunction(
  { id: "send-order-confirmation" },
  { event: "commerce/send-order-confirmation" },
  async ({ event }) => {
    const { orderId, customerId } = event.data
    // ... send the email
  },
)
```

This keeps job handler code out of the core and in the application layer where it belongs. The core only defines the enqueue contract.

### 6.5 What does not change

The hook system is unchanged. Hooks remain the primary and recommended extension mechanism. `ctx.jobs.enqueue` is an escape hatch for work that genuinely must not block the request. Developers should default to hooks and reach for job enqueueing only when they have a specific latency or reliability requirement for a side effect.

---

## 7. Part 5 -- Query Composition Layer

### 7.1 Problem statement

API route handlers that return resources with related data currently call multiple services and manually assemble the response. This is verbose, error-prone, produces multiple serial database round-trips, and puts data-assembly logic in the wrong layer.

We need a composition API that takes a request for a primary entity with a set of related includes, and resolves all of it in the minimum number of database queries, returning a single typed object.

### 7.2 The N+1 problem and why batching is mandatory

A naive `include` implementation that fetches related records in a loop produces N+1 queries. For a list of 50 orders each with a customer, a naive implementation would execute 1 (orders) + 50 (customers, one per order) = 51 queries. For 100 orders it would be 101. This is not acceptable.

The correct implementation collects all foreign key values from the primary result set, issues a single `WHERE id IN (...)` query for each included relation, then maps the results in memory. For 50 orders the above example becomes 2 queries regardless of how many orders are in the list. This is called the dataloader pattern and it is how Prisma's `include`, Medusa's Remote Query, and every production-safe ORM eager-loading implementation works.

### 7.3 Scope of this implementation

This is not a general-purpose graph query system. It is not GraphQL. It is a simple, opinionated include resolver built specifically for the data shapes that commerce API routes need.

The include paths supported in v1 are:

- One level deep: `["customer", "payment", "items"]`
- Two levels deep: `["items.product", "items.variant"]`
- No deeper than two levels in the initial implementation.

Each module registers its includeable relations with the kernel at startup. The query composition layer uses these registrations to know which service method to call, which foreign key to batch on, and how to attach the results.

### 7.4 Pseudo-code

```
define a Relation as:
  name:         string (e.g., "customer")
  foreignKey:   string (the key on the parent row, e.g., "customerId")
  targetModule: string (e.g., "customers")
  fetchMethod:  string (the service method to batch-fetch by IDs, e.g., "listByIds")
  attachAs:     string (the key to attach results under, e.g., "customer")
  isList:       boolean (true if one parent has many of this relation)

kernel.query({ entity, id?, filters?, include, pagination }):
  1. Fetch primary records
     if id is provided: call entity service's getById(id) -- returns one record
     if filters are provided: call entity service's list(filters, pagination) -- returns array

  2. For each include path:
     a. Collect all foreign key values from the primary records
        (deduplicate -- do not fetch the same record twice)
     b. Call the relation's fetchMethod on the target service with the collected IDs
        (one query via WHERE id IN (...))
     c. Build a lookup map: Map<foreignKeyValue, relatedRecord>
     d. Attach the related record to each primary record

  3. For nested includes (e.g., "items.product"):
     a. After resolving "items" in step 2, the primary records now have .items arrays
     b. Flatten all items across all primary records into one list
     c. Collect all productId foreign key values
     d. Batch-fetch products via WHERE id IN (...)
     e. Attach products to items

  4. Return the enriched primary records
```

### 7.5 Relation registration

Modules register their relations at startup via the kernel:

```typescript
// packages/core/src/kernel/query/registry.ts

export interface RelationDefinition {
  /** The key on the source row that holds the foreign key value. */
  foreignKey: string
  /** The name of the service in kernel.services that owns the related records. */
  targetService: string
  /**
   * The method on the target service that accepts an array of IDs and returns
   * an array of matching records. This method must exist and must accept
   * string[] as its first argument.
   */
  batchMethod: string
  /** The key to set on the source row when attaching the result. */
  attachAs: string
  /** If true, the relation is one-to-many and the result is an array. */
  isList?: boolean
}

export interface EntityDefinition {
  /** The service key in kernel.services that owns the primary records. */
  service: string
  /** The method that returns a single record by id. */
  getByIdMethod: string
  /** The method that returns a list of records (with filters and pagination). */
  listMethod: string
  /** Declared includeable relations. */
  relations: Record<string, RelationDefinition>
}

/**
 * QueryRegistry holds the entity and relation registrations that
 * kernel.query uses to resolve include paths.
 */
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

### 7.6 Query executor

```typescript
// packages/core/src/kernel/query/executor.ts

import type { QueryRegistry, EntityDefinition, RelationDefinition } from "./registry"
import { CommerceNotFoundError } from "../errors"

export interface QueryInput {
  entity: string
  id?: string
  filters?: Record<string, unknown>
  include?: string[]
  pagination?: { limit?: number; offset?: number }
}

export interface QueryResult<T> {
  data: T[]
  total?: number
}

export async function executeQuery<T = Record<string, unknown>>(
  registry: QueryRegistry,
  services: Record<string, unknown>,
  input: QueryInput,
): Promise<QueryResult<T>> {
  const definition = registry.get(input.entity)
  if (!definition) {
    throw new CommerceNotFoundError(`No entity registered with name "${input.entity}".`)
  }

  const service = services[definition.service] as Record<string, (...args: any[]) => Promise<any>>

  // 1. Fetch primary records.
  let rows: T[]
  let total: number | undefined

  if (input.id) {
    const result = await service[definition.getByIdMethod](input.id)
    if (!result || (result && result.ok === false)) {
      throw new CommerceNotFoundError(`${input.entity} with id "${input.id}" not found.`)
    }
    rows = [result.value ?? result]
  } else {
    const result = await service[definition.listMethod](
      input.filters ?? {},
      input.pagination,
    )
    rows = result.value?.items ?? result.value ?? result
    total = result.value?.total ?? result.meta?.total
  }

  if (!input.include || input.include.length === 0) {
    return { data: rows, total }
  }

  // 2. Resolve includes using batched queries.
  await resolveIncludes(rows, input.include, definition, services, registry)

  return { data: rows, total }
}

async function resolveIncludes(
  rows: any[],
  includes: string[],
  definition: EntityDefinition,
  services: Record<string, unknown>,
  registry: QueryRegistry,
): Promise<void> {
  // Group includes by top-level path segment.
  // "customer" -> top level
  // "items.product" -> "items" is top level, "product" is nested
  const topLevel = new Map<string, string[]>()

  for (const path of includes) {
    const dot = path.indexOf(".")
    if (dot === -1) {
      topLevel.set(path, [])
    } else {
      const parent = path.substring(0, dot)
      const child = path.substring(dot + 1)
      topLevel.set(parent, [...(topLevel.get(parent) ?? []), child])
    }
  }

  for (const [relationName, nestedIncludes] of topLevel) {
    const relation = definition.relations[relationName]
    if (!relation) continue

    await resolveSingleRelation(rows, relation, services, registry, nestedIncludes)
  }
}

async function resolveSingleRelation(
  rows: any[],
  relation: RelationDefinition,
  services: Record<string, unknown>,
  registry: QueryRegistry,
  nestedIncludes: string[],
): Promise<void> {
  const targetService = services[relation.targetService] as Record<
    string,
    (...args: any[]) => Promise<any>
  >

  if (!targetService) return

  // Collect all foreign key values from the primary rows (deduplicated).
  const ids = [...new Set(
    rows
      .map(row => row[relation.foreignKey])
      .filter(Boolean),
  )]

  if (ids.length === 0) return

  // One batched query for all related records.
  const relatedResult = await targetService[relation.batchMethod](ids)
  const relatedRows: any[] = relatedResult.value ?? relatedResult

  // Build lookup map.
  const map = new Map<string, any>()
  for (const related of relatedRows) {
    map.set(related.id, related)
  }

  // Attach to primary rows.
  for (const row of rows) {
    const fkValue = row[relation.foreignKey]
    if (!fkValue) continue
    row[relation.attachAs] = map.get(fkValue) ?? null
  }

  // Resolve nested includes if any.
  if (nestedIncludes.length > 0) {
    const targetDefinition = registry.get(relation.targetService)
    if (targetDefinition) {
      const nestedRows = rows.map(r => r[relation.attachAs]).filter(Boolean)
      await resolveIncludes(nestedRows, nestedIncludes, targetDefinition, services, registry)
    }
  }
}
```

### 7.7 Kernel integration

The kernel exposes `query` as a first-class method alongside `services`:

```typescript
// In packages/core/src/runtime/kernel.ts

// At startup, register entities and their relations:
kernel.queryRegistry.register("order", {
  service: "orders",
  getByIdMethod: "getById",
  listMethod: "list",
  relations: {
    customer: {
      foreignKey: "customerId",
      targetService: "customers",
      batchMethod: "listByIds",
      attachAs: "customer",
    },
    lineItems: {
      foreignKey: "id",
      targetService: "orders",
      batchMethod: "listLineItemsByOrderIds",
      attachAs: "lineItems",
      isList: true,
    },
  },
})

// The query method on the kernel:
kernel.query = (input) => executeQuery(kernel.queryRegistry, kernel.services, input)
```

### 7.8 Route handler usage

Before:
```typescript
// packages/core/src/interfaces/rest/routes/orders.ts -- current pattern
app.get("/orders/:id", async (c) => {
  const { id } = c.req.param()
  const orderResult = await services.orders.getById(id)
  if (!orderResult.ok) return c.json({ error: "Not found" }, 404)

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
  const { id } = c.req.param()
  const result = await kernel.query({
    entity: "order",
    id,
    include: ["customer", "payment", "lineItems"],
  })

  if (result.data.length === 0) return c.json({ error: "Not found" }, 404)
  return c.json({ order: result.data[0] })
})
```

For list endpoints:
```typescript
app.get("/orders", async (c) => {
  const { limit = 50, offset = 0, status } = c.req.query()
  const result = await kernel.query({
    entity: "order",
    filters: status ? { status } : undefined,
    include: ["customer"],
    pagination: { limit: Number(limit), offset: Number(offset) },
  })
  return c.json({ orders: result.data, total: result.total })
})
```

### 7.9 Service requirements for query composition

Each service that participates in query composition must expose a `listByIds(ids: string[])` method (or equivalent named per the `batchMethod` registration). This is a small contract change. For most services, this method is trivially implemented using the repository factory:

```typescript
// In OrderService:
async listByIds(ids: string[]) {
  return this.repo.findMany({ id: ids as any })  // or using inArray() directly
}
```

This is not a breaking change to existing service APIs. Services that are not registered with the query registry are not affected at all.

---

## 8. Adoption Path

The five changes in this RFC are independent. They can be implemented and shipped in any order, and none of them requires simultaneous changes to the application layer.

**Recommended implementation order:**

### Phase A -- Concurrency safety and compensation (no new API surface)

1. Add `version` column to `inventory_levels`. Write and run migration.
2. Add `findLevelForUpdate` and `reserveWithLock` to `InventoryRepository`.
3. Update `InventoryService.reserve` to use `withTransaction` + `reserveWithLock`.
4. Implement `runCompensationChain` executor (approximately 60 lines).
5. Write `reserveInventoryStep` and `capturePaymentStep` with compensation functions.
6. Replace the `capturePayment` and `reserveInventory` AfterHooks with a single `completeCheckout` AfterHook that uses the compensation chain.

This phase requires zero changes to `defineCommercePlugin`, `defineConfig`, or any consumer-facing API.

### Phase B -- Factory (internal refactor)

7. Implement `createRepository` factory.
8. Implement `createInMemoryRepository` factory.
9. Migrate two or three modules to use the factory as a proof of pattern.
10. Migrate remaining modules.

No consumer-facing API changes. Tests should continue to pass without modification.

### Phase C -- Jobs adapter and query composition (new API surface)

11. Define `JobsAdapter` interface and `NullJobsAdapter`.
12. Add optional `jobs` property to `CommerceConfig`.
13. Wire adapter into `HookContext`.
14. Define `QueryRegistry`, `EntityDefinition`, `RelationDefinition`.
15. Implement `executeQuery` and `resolveIncludes`.
16. Register core entities with the query registry in the kernel.
17. Add `kernel.query()` method.
18. Add `listByIds` to services that will be registered.
19. Update select route handlers to use `kernel.query()`.

Phase C introduces new API surface. It should not change existing route behavior -- it is strictly additive.

---

## 9. Open Questions

**Q1: Should compensation step order be configurable by plugins?**

Currently, compensation chain steps are hardcoded in the core checkout pipeline. The open question is whether plugins should be able to insert steps before or after existing ones (for example, a fraud detection step that must precede payment capture and trigger its own compensation if fraud is detected). This would require a step registry and a position descriptor. It is intentionally out of scope for this RFC but the architecture does not preclude it.

**Q2: What is the behavior when a `listByIds` result is partial (some IDs not found)?**

If `listByIds` returns 45 records for 50 IDs, the query composition layer should silently attach `null` for the 5 missing records. This is the safe default. An option to throw on missing related records (`{ strict: true }`) is worth considering but is not in scope here.

**Q3: Should the repository factory support cursor-based pagination?**

The current `FindOptions` uses `limit` and `offset` which is standard but degrades for very large datasets (offset scans are slow on large tables). Cursor-based pagination (using a `cursor` column with a `WHERE id > :cursor` pattern) is more efficient for large or frequently-updated datasets. This is additive and can be added to the factory's `findMany` and `findAndCount` signatures in a follow-up without breaking existing callers.

**Q4: Should `kernel.query()` support field selection (return only specified columns)?**

The current design returns all columns of each entity. Adding a `fields: string[]` parameter to reduce the SELECT surface is useful for performance and for API responses that should not expose internal fields. This would require the factory's `findMany` method to support column projection. Not in scope here but the registry definition has a natural place for a `defaultFields` array.

**Q5: Transaction isolation for the compensation chain**

The current `runCompensationChain` runs each step independently. If step 1 (reserve inventory) and step 2 (capture payment) should be within the same database transaction, the caller needs to wrap both in `withTransaction` and pass the resulting `TxContext` into the compensation context. This is supported by the design (the `ctx.tx` field), but the checkout pipeline does not currently use it because payment capture is an external HTTP call, not a database operation. The compensation chain executor should document clearly that steps involving external systems (payment providers, email APIs) are not transactional and rely on the compensation function for rollback.
