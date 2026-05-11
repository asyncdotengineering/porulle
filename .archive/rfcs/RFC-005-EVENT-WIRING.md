# RFC-005: Event Wiring — Async Webhooks, Auto-Audit, Expanded Webhook Coverage

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-14
- **Scope:** `packages/core` (webhooks, audit, hooks)
- **Depends on:** RFC-004 (implemented)
- **Related:** RFC-006 (persistent analytics — separated into its own RFC)
- **Estimated effort:** 2 days

---

## 1. Summary

The engine has all the infrastructure for a production event system — a hook registry, a job queue with retries, a webhook delivery worker, an audit log table, and an analytics service. But these systems are wired incorrectly:

- Webhook delivery happens **synchronously inside hook handlers**, blocking the HTTP response
- Audit logging covers **1 of 14 modules** (only `orders.changeStatus`), manually called
- Analytics events are stored **in-memory** and lost on server restart
- The `commerce_jobs` table exists but webhooks don't use it

This RFC fixes the wiring between existing systems. No new adapter interfaces, no new architectural patterns, no new tables. The job queue becomes the async delivery mechanism for webhooks. Audit logging becomes automatic via hook registration. Analytics events get persisted via the job queue.

---

## 2. Motivation

### 2.1 Webhook Delivery Blocks Requests

Current flow when an order is created:

```
POST /api/checkout
  → createOrder()
    → runAfterHooks()
      → deliverWebhooks()
        → for each endpoint:
            → HTTP POST to endpoint URL (waits for response)
            → retry up to 3x on failure (blocks for seconds)
      → recordAnalyticsEvent()
  ← 201 response returned to customer
```

If a webhook endpoint is slow (2s response) and there are 3 endpoints subscribed, the checkout response is delayed by 6+ seconds. If an endpoint is down, 3 retries × 2^n backoff = 14 seconds of blocking before the customer gets their order confirmation.

**After this RFC:**

```
POST /api/checkout
  → createOrder()
    → runAfterHooks()
      → deliverWebhooks()
        → for each endpoint:
            → ctx.jobs.enqueue("webhooks/deliver", { endpointId, payload })
      → recordAnalyticsEvent()
  ← 201 response returned immediately

Background (async):
  job runner picks up "webhooks/deliver" jobs
  → WebhookDeliveryWorker.deliver() with retries
  → Records delivery attempt in webhook_deliveries
```

### 2.2 Audit Coverage Is 7%

The `commerce_audit_log` table exists and works. But only one operation writes to it:

| Module | Operations | Audited? |
|--------|-----------|----------|
| Orders | create, statusChange, cancel, refund | Only statusChange |
| Catalog | create, update, delete, publish, archive | None |
| Inventory | adjust, reserve, release | None |
| Cart | create, addItem, removeItem, updateQty | None |
| Customers | create, update, delete | None |
| Pricing | setBasePrice, createModifier | None |
| Promotions | create, update, deactivate | None |
| Fulfillment | fulfillOrder | None |
| Webhooks | createEndpoint, deleteEndpoint | None |
| Media | upload, delete | None |
| Marketplace | vendor CRUD, sub-order transitions | None |

A developer asking "who changed this product's price last week?" gets no answer. An operator investigating a missing inventory adjustment has no audit trail. A compliance review for financial operations (payouts, refunds) has no evidence.

### 2.3 Analytics Events Vanish on Restart

`AnalyticsService.recordEvent()` pushes to an in-memory array:

```typescript
private analyticsEvents: AnalyticsEvent[] = [];

recordEvent(event: AnalyticsEvent) {
  this.analyticsEvents.push(event);
}
```

Server restart, crash, or container recycle = all analytics history gone. The analytics query engine (`query()`) then returns zeros for everything until enough new events accumulate.

---

## 3. Design Principles

1. **Fix wiring, not architecture.** Use the existing hook registry, job queue, audit service, and webhook worker. No new adapter interfaces.
2. **Same transaction for audit.** Audit writes happen in the same DB transaction as the business operation (via before/after hooks that receive `ctx.tx`). If the operation rolls back, the audit entry rolls back too.
3. **Different transaction for webhooks.** Webhook delivery is a background job — it runs after the HTTP response is sent, in its own transaction. At-least-once delivery via the job queue's retry mechanism.
4. **Opt-out, not opt-in.** Audit logging is automatic for all modules by default. A developer can disable it per-module via config if needed.

---

## 4. Change 1: Async Webhook Delivery via Job Queue

### Current Code

`packages/core/src/modules/webhooks/hook.ts`:

```typescript
export const deliverWebhooks: AfterHook<unknown> = async ({ result, context }) => {
  const webhooks = context.services.webhooks as WebhookServiceLike;
  const endpoints = await webhooks.findEndpointsForEvent(eventName);

  for (const endpoint of endpoints) {
    // BLOCKS: synchronous HTTP call inside the hook
    await webhooks.enqueueDelivery({
      endpoint: { id: endpoint.id, url: endpoint.url, secret: endpoint.secret },
      eventName,
      payload: result,
    });
  }
};
```

`enqueueDelivery` calls `WebhookDeliveryWorker.deliver()` which does the HTTP POST inline with retries.

### Proposed Change

Replace the inline delivery with a job queue enqueue:

```typescript
export const deliverWebhooks: AfterHook<unknown> = async ({ result, context }) => {
  const webhooks = context.services.webhooks as WebhookServiceLike;
  const endpoints = await webhooks.findEndpointsForEvent(eventName);

  for (const endpoint of endpoints) {
    // NON-BLOCKING: enqueue for async delivery
    await context.jobs.enqueue("webhooks/deliver", {
      endpointId: endpoint.id,
      endpointUrl: endpoint.url,
      endpointSecret: endpoint.secret,
      eventName,
      payload: result,
    }, {
      maxAttempts: 5,
      queue: "webhooks",
    });
  }
};
```

Register the webhook delivery task in the kernel:

```typescript
const webhookDeliveryTask: TaskDefinition = {
  slug: "webhooks/deliver",
  async handler({ input, ctx }) {
    const worker = new WebhookDeliveryWorker({
      repository: ctx.services.webhooks.repository,
    });
    await worker.deliver({
      endpoint: {
        id: input.endpointId,
        url: input.endpointUrl,
        secret: input.endpointSecret,
      },
      eventName: input.eventName,
      payload: input.payload,
    });
    return { output: { delivered: true } };
  },
  retries: { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
};
```

### Impact

- Checkout response time: ~100ms faster per webhook endpoint
- Webhook delivery: at-least-once via job queue retries (was already at-least-once via inline retries)
- Failure isolation: a down webhook endpoint cannot block checkout
- Observability: webhook delivery jobs visible in `commerce_jobs` table with status, attempts, errors

### Files Changed

| File | Change |
|------|--------|
| `packages/core/src/modules/webhooks/hook.ts` | Replace inline delivery with `ctx.jobs.enqueue()` |
| `packages/core/src/modules/webhooks/tasks.ts` | NEW — webhook delivery task definition |
| `packages/core/src/runtime/kernel.ts` | Register webhook delivery task |

---

## 5. Change 2: Auto-Audit via Hook Registration

### Current Code

Audit logging is a manual `audit.record()` call in one place:

```typescript
// orders/service.ts line 508
if (audit?.record) {
  await audit.record({
    entityType: "order",
    entityId: order.id,
    event: "status_changed",
    payload: { from: previous, to: input.newStatus, reason: input.reason },
    ctx: hookCtx,
  });
}
```

### Proposed Change

Create a generic `createAuditHook(entityType, event)` factory and register it on all service operations:

```typescript
// packages/core/src/modules/audit/hooks.ts

function createAuditAfterHook(entityType: string, event: string): AfterHook<{ id: string }> {
  return async ({ result, context }) => {
    const audit = context.services.audit as AuditService | undefined;
    if (!audit?.record) return;

    await audit.record({
      entityType,
      entityId: result.id ?? "unknown",
      event,
      payload: result,
      ctx: context,
    });
  };
}

function createAuditBeforeDeleteHook(entityType: string): BeforeHook<{ id: string }> {
  return async ({ data, context }) => {
    const audit = context.services.audit as AuditService | undefined;
    if (!audit?.record) return data;

    await audit.record({
      entityType,
      entityId: data.id,
      event: "deleted",
      payload: { id: data.id },
      ctx: context,
    });

    return data;
  };
}

// Export all audit hooks for kernel registration
export const auditHooks = {
  "catalog.afterCreate": createAuditAfterHook("catalog_entity", "created"),
  "catalog.afterUpdate": createAuditAfterHook("catalog_entity", "updated"),
  "catalog.afterDelete": createAuditBeforeDeleteHook("catalog_entity"),
  "orders.afterCreate": createAuditAfterHook("order", "created"),
  "orders.afterStatusChange": createAuditAfterHook("order", "status_changed"),
  "inventory.afterAdjust": createAuditAfterHook("inventory", "adjusted"),
  "customers.afterCreate": createAuditAfterHook("customer", "created"),
  "customers.afterUpdate": createAuditAfterHook("customer", "updated"),
  "pricing.afterCreate": createAuditAfterHook("price", "created"),
  "pricing.afterUpdate": createAuditAfterHook("price", "updated"),
  "promotions.afterCreate": createAuditAfterHook("promotion", "created"),
  "promotions.afterUpdate": createAuditAfterHook("promotion", "updated"),
};
```

Register in kernel boot:

```typescript
// kernel.ts — after registerConfiguredHooks()
for (const [key, handler] of Object.entries(auditHooks)) {
  hooks.append(key, handler as HookHandler);
}
```

Remove the manual `audit.record()` call from `orders/service.ts` — it's now handled by the hook.

### Impact

- Every create/update/delete across all modules automatically logged
- Audit entries written in the same transaction as the operation (via `ctx.tx` in hooks)
- Zero changes to existing service code — audit is a cross-cutting concern handled at the hook layer
- Developers can query `commerce_audit_log` for complete operation history

### Files Changed

| File | Change |
|------|--------|
| `packages/core/src/modules/audit/hooks.ts` | NEW — audit hook factory + registrations |
| `packages/core/src/runtime/kernel.ts` | Register audit hooks |
| `packages/core/src/modules/orders/service.ts` | Remove manual `audit.record()` call |

---

## 6. Change 3: Audit REST API

### Proposed Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/audit` | List audit entries (filters: `?entityType`, `?entityId`, `?event`, `?actorId`, `?from`, `?to`) |
| `GET` | `/api/audit/:entityType/:entityId` | List audit history for a specific entity |

### Implementation

```typescript
// packages/core/src/interfaces/rest/routes/audit.ts

app.get("/api/audit", async (c) => {
  const entries = await kernel.services.audit.list({
    entityType: c.req.query("entityType"),
    entityId: c.req.query("entityId"),
    event: c.req.query("event"),
    actorId: c.req.query("actorId"),
    from: c.req.query("from") ? new Date(c.req.query("from")) : undefined,
    to: c.req.query("to") ? new Date(c.req.query("to")) : undefined,
    limit: Number(c.req.query("limit") ?? 50),
  });
  return c.json({ data: entries });
});

app.get("/api/audit/:entityType/:entityId", async (c) => {
  const entries = await kernel.services.audit.listForEntity({
    entityType: c.req.param("entityType"),
    entityId: c.req.param("entityId"),
  });
  return c.json({ data: entries });
});
```

### Files Changed

| File | Change |
|------|--------|
| `packages/core/src/interfaces/rest/routes/audit.ts` | NEW — audit REST endpoints |
| `packages/core/src/interfaces/rest/index.ts` | Mount audit routes |
| `packages/core/src/modules/audit/service.ts` | Add `list()` method with filters |

---

## 7. Persistent Analytics (Deferred → RFC-006)

Persistent analytics has been separated into its own RFC (RFC-006) because it involves a larger architectural decision: whether to use a SQL-based query engine or integrate Cube.js as a semantic layer. See [RFC-006](./RFC-006-PERSISTENT-ANALYTICS.md) for the full analysis.

---

## 8. Webhook Event Coverage Expansion

### Current Coverage (4 events)

```
orders.afterCreate → deliverWebhooks
orders.afterStatusChange → deliverWebhooks
catalog.afterCreate → deliverWebhooks
catalog.afterUpdate → deliverWebhooks
```

### Proposed Coverage (14 events)

```
orders.afterCreate → deliverWebhooks
orders.afterStatusChange → deliverWebhooks
catalog.afterCreate → deliverWebhooks
catalog.afterUpdate → deliverWebhooks
catalog.afterDelete → deliverWebhooks          ← NEW
inventory.afterAdjust → deliverWebhooks        ← NEW
customers.afterCreate → deliverWebhooks        ← NEW
customers.afterUpdate → deliverWebhooks        ← NEW
pricing.afterCreate → deliverWebhooks          ← NEW
pricing.afterUpdate → deliverWebhooks          ← NEW
promotions.afterCreate → deliverWebhooks       ← NEW
promotions.afterUpdate → deliverWebhooks       ← NEW
fulfillment.afterCreate → deliverWebhooks      ← NEW
cart.afterAddItem → deliverWebhooks            ← NEW
```

### Implementation

One line per event in kernel.ts:

```typescript
hooks.append("catalog.afterDelete", deliverWebhooks);
hooks.append("inventory.afterAdjust", deliverWebhooks);
hooks.append("customers.afterCreate", deliverWebhooks);
// ... etc
```

No code changes to `deliverWebhooks` — it already reads the event name from the hook key and queries endpoints subscribed to that event.

### Files Changed

| File | Change |
|------|--------|
| `packages/core/src/runtime/kernel.ts` | Add 10 new `hooks.append()` calls |

---

## 9. Implementation Plan

### Day 1: Async Webhooks + Event Coverage

1. Create `webhooks/tasks.ts` with delivery task definition
2. Modify `webhooks/hook.ts` to enqueue instead of inline deliver
3. Register task in kernel
4. Add 10 new webhook hook registrations in kernel
5. Test: checkout response time, webhook delivery via job queue

### Day 2: Auto-Audit + REST API

6. Create `audit/hooks.ts` with audit hook factory
7. Register audit hooks in kernel for all modules
8. Remove manual `audit.record()` from orders service
9. Add `list()` method to audit service with filters
10. Create `audit` REST routes
11. Test: audit entries created for catalog/inventory/customer operations

### Day 2 (continued): Tests

12. Integration tests: audit entries created for catalog/inventory/customer operations
13. Integration tests: audit queryable via REST API
14. Integration tests: webhook delivery works via job queue

---

## 10. What This Does NOT Do

- **No new adapter interface.** Events are handled by existing hooks + jobs.
- **No event bus.** The hook registry IS the pub/sub system.
- **No event sourcing.** We store the current state + audit log, not event streams.
- **No message broker.** The job queue table IS the outbox. External message buses (SQS, Pub/Sub) are a future adapter, not needed at current scale.
- **No breaking changes.** All existing hook registrations continue to work. Webhook endpoints receive the same payloads. The only observable difference is that webhooks arrive slightly later (async instead of inline).

---

## 11. Key Files

| File | Change Type |
|------|-------------|
| `packages/core/src/modules/webhooks/hook.ts` | MODIFY (enqueue instead of inline deliver) |
| `packages/core/src/modules/webhooks/tasks.ts` | NEW (webhook delivery task) |
| `packages/core/src/modules/audit/hooks.ts` | NEW (audit hook factory) |
| `packages/core/src/modules/audit/service.ts` | MODIFY (add `list()` with filters) |
| `packages/core/src/interfaces/rest/routes/audit.ts` | NEW (audit REST endpoints) |
| `packages/core/src/runtime/kernel.ts` | MODIFY (register tasks, audit hooks, webhook events) |
| `packages/core/src/modules/orders/service.ts` | MODIFY (remove manual audit call) |
