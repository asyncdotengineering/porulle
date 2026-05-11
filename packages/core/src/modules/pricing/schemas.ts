import { z } from "@hono/zod-openapi";

// ─── Zod Body Schemas (single source of truth) ─────────────────────────────

export const SetBasePriceBodySchema = z.object({
  entityId: z.string().openapi({ example: "product-uuid" }),
  variantId: z.string().optional().openapi({ example: "variant-uuid" }),
  currency: z.string().length(3).openapi({ example: "USD" }),
  amount: z.number().openapi({ example: 29.99 }),
  customerGroupId: z.string().optional(),
  minQuantity: z.number().int().optional(),
  maxQuantity: z.number().int().optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("SetBasePriceRequest");

export const CreateModifierBodySchema = z.object({
  name: z.string().openapi({ example: "Summer Sale" }),
  type: z.enum(["percentage_discount", "fixed_discount", "markup", "override"]).openapi({ example: "percentage_discount" }),
  value: z.number().openapi({ example: 10 }),
  priority: z.number().int().optional(),
  entityId: z.string().optional(),
  variantId: z.string().optional(),
  customerGroupId: z.string().optional(),
  currency: z.string().length(3).optional().openapi({ example: "USD" }),
  minQuantity: z.number().int().optional(),
  maxQuantity: z.number().int().optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateModifierRequest");

// ─── Derived Input Types ────────────────────────────────────────────────────

export type SetBasePriceInput = z.infer<typeof SetBasePriceBodySchema>;
export type CreatePriceModifierInput = z.infer<typeof CreateModifierBodySchema>;
