import type { AfterHook } from "../../kernel/hooks/types.js";
import type { HookHandler } from "../../kernel/hooks/registry.js";
import type { AuditService } from "./service.js";
import type { ImportProductsReport } from "../catalog/import-service.js";
import type { InventoryAdjustManyResult } from "../inventory/service.js";

/**
 * Creates an after-hook that records an audit entry for the operation.
 *
 * The audit entry is written using the same transaction context as the
 * business operation (via ctx.tx). If the operation rolls back, the
 * audit entry rolls back too.
 */
function createAuditAfterHook(entityType: string, event: string): AfterHook<Record<string, unknown>> {
  return async ({ result, context }) => {
    const audit = context.services.audit as AuditService | undefined;
    if (!audit?.record) return;

    const entityId = (result as { id?: string })?.id ?? "unknown";

    await audit.record({
      entityType,
      entityId,
      event,
      payload: safePayload(result),
      ctx: context,
    });
  };
}

/**
 * Strips the result to a safe subset for audit logging.
 * Avoids storing sensitive fields or excessively large payloads.
 */
function safePayload(result: unknown): Record<string, unknown> {
  if (result == null || typeof result !== "object") return {};
  const obj = result as Record<string, unknown>;

  // Shallow copy, exclude fields that could be huge
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip binary data, nested arrays > 10 items, and known sensitive fields
    if (key === "password" || key === "secret" || key === "bankAccount") continue;
    if (Array.isArray(value) && value.length > 10) {
      safe[key] = `[${value.length} items]`;
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

/**
 * All audit hooks, keyed by hook registration key.
 * Registered in kernel boot via hooks.append().
 */
/**
 * One audit row per imported PAGE. The fast path fires no `catalog.afterCreate`, so the per-entity
 * "created" rows do not exist for imported products; the page row names the store and the counts.
 */
const catalogImportAuditHook: AfterHook<ImportProductsReport> = async ({ result, context }) => {
  const audit = context.services.audit as AuditService | undefined;
  if (!audit?.record) return;
  await audit.record({
    entityType: "catalog_import",
    entityId: result.sourceStoreId,
    event: "imported",
    payload: { created: result.created, failed: result.failed },
    ctx: context,
  });
};

/**
 * `inventory.afterAdjustMany` — one page of absolute levels. Each changed level is still its own
 * audit entry (as `inventory.afterAdjust` records one per adjust), written in ONE insert.
 */
const inventoryAdjustManyAuditHook: AfterHook<InventoryAdjustManyResult> = async ({ result, context }) => {
  const audit = context.services.audit as AuditService | undefined;
  if (!audit?.recordMany) return;
  await audit.recordMany(result.entities.flatMap((entity) => entity.levels.map((level) => ({
    entityType: "inventory",
    entityId: level.id,
    event: "adjusted",
    payload: safePayload(level),
  }))), context);
};

export const auditHooks: Record<string, HookHandler> = {
  // Catalog
  "catalog.afterCreate": createAuditAfterHook("catalog_entity", "created") as HookHandler,
  "catalog.afterUpdate": createAuditAfterHook("catalog_entity", "updated") as HookHandler,
  "catalog.afterImport": catalogImportAuditHook as HookHandler,

  // Orders
  "orders.afterCreate": createAuditAfterHook("order", "created") as HookHandler,
  "orders.afterStatusChange": createAuditAfterHook("order", "status_changed") as HookHandler,

  // Inventory
  "inventory.afterAdjust": createAuditAfterHook("inventory", "adjusted") as HookHandler,
  "inventory.afterAdjustMany": inventoryAdjustManyAuditHook as HookHandler,

  // Customers
  "customers.afterCreate": createAuditAfterHook("customer", "created") as HookHandler,
  "customers.afterUpdate": createAuditAfterHook("customer", "updated") as HookHandler,

  // Pricing
  "pricing.afterCreate": createAuditAfterHook("price", "created") as HookHandler,
  "pricing.afterUpdate": createAuditAfterHook("price", "updated") as HookHandler,

  // Promotions
  "promotions.afterCreate": createAuditAfterHook("promotion", "created") as HookHandler,
  "promotions.afterUpdate": createAuditAfterHook("promotion", "updated") as HookHandler,
};
