import { z } from "@hono/zod-openapi";

// ─── Zod Body Schemas (single source of truth) ─────────────────────────────

export const InventoryAdjustBodySchema = z.object({
  entityId: z.string().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  variantId: z.string().optional().openapi({ example: "variant-uuid" }),
  warehouseId: z.string().optional().openapi({ example: "warehouse-uuid" }),
  // Signed-delta form (legacy/default). Required when `mode` is omitted.
  adjustment: z.number().int().refine((v) => v !== 0, { message: "Adjustment cannot be zero" }).optional().openapi({ example: 10 }),
  // Mode form. `add`/`remove`/`set` operate on the unsigned `amount`.
  // `remove` clamps at 0; `set` writes the absolute quantity.
  mode: z.enum(["add", "remove", "set"]).optional().openapi({ example: "add" }),
  amount: z.number().int().min(0).optional().openapi({ example: 5 }),
  reason: z.string().openapi({ example: "Restock from supplier" }),
  performedBy: z.string().optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
}).openapi("InventoryAdjustRequest");

export const InventoryReserveBodySchema = z.object({
  entityId: z.string().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  variantId: z.string().optional(),
  warehouseId: z.string().optional(),
  quantity: z.number().int().min(1).openapi({ example: 2 }),
  orderId: z.string().openapi({ example: "order-uuid" }),
  performedBy: z.string().optional(),
}).openapi("InventoryReserveRequest");

export const InventoryReleaseBodySchema = z.object({
  entityId: z.string().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  variantId: z.string().optional(),
  warehouseId: z.string().optional(),
  quantity: z.number().int().min(1).openapi({ example: 2 }),
  orderId: z.string().openapi({ example: "order-uuid" }),
  performedBy: z.string().optional(),
}).openapi("InventoryReleaseRequest");

// ─── Derived Input Types ────────────────────────────────────────────────────

export type InventoryAdjustInput = z.infer<typeof InventoryAdjustBodySchema>;
export type InventoryReserveInput = z.infer<typeof InventoryReserveBodySchema>;
export type InventoryReleaseInput = z.infer<typeof InventoryReleaseBodySchema>;
