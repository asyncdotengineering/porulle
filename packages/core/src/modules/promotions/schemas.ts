import { z } from "@hono/zod-openapi";

// ─── Zod Body Schemas (single source of truth) ─────────────────────────────

export const CreatePromotionBodySchema = z.object({
  name: z.string().openapi({ example: "Summer Sale" }),
  type: z.enum([
    "percentage_off_order",
    "fixed_off_order",
    "percentage_off_item",
    "fixed_off_item",
    "free_shipping",
    "buy_x_get_y",
  ]).openapi({ example: "percentage_off_order" }),
  value: z.number().openapi({ example: 10 }),
  code: z.string().optional().openapi({ example: "SUMMER10" }),
  buyQuantity: z.number().int().optional(),
  getQuantity: z.number().int().optional(),
  isAutomatic: z.boolean().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
  conditions: z.object({
    minimumOrderValue: z.number().optional(),
    minimumQuantity: z.number().int().optional(),
    entityTypes: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    customerGroups: z.array(z.string()).optional(),
  }).optional(),
  usageLimitTotal: z.number().int().optional(),
  usageLimitPerCustomer: z.number().int().optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreatePromotionRequest");

// ─── Derived Input Types ────────────────────────────────────────────────────

export type CreatePromotionInput = z.infer<typeof CreatePromotionBodySchema>;
