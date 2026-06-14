import { z } from "@hono/zod-openapi";

// ─── Zod Body Schemas (single source of truth) ─────────────────────────────

/**
 * The valid promotion `type` values. Single source of truth for the REST
 * body schema, the OpenAPI enum, the service-layer validation, and the
 * exported {@link PromotionType} union.
 */
export const promotionTypeEnum = z
  .enum([
    "percentage_off_order",
    "fixed_off_order",
    "percentage_off_item",
    "fixed_off_item",
    "free_shipping",
    "buy_x_get_y",
  ])
  .openapi("PromotionType", { example: "percentage_off_order" });

/** Valid promotion type discriminator. @see promotionTypeEnum */
export type PromotionType = z.infer<typeof promotionTypeEnum>;

export const CreatePromotionBodySchema = z.object({
  name: z.string().openapi({ example: "Summer Sale" }),
  /** @see PromotionType for valid values */
  type: promotionTypeEnum,
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

// Edit any subset of the create body. Validated the same way create is.
export const UpdatePromotionBodySchema = CreatePromotionBodySchema.partial();

// ─── Derived Input Types ────────────────────────────────────────────────────

export type CreatePromotionInput = z.infer<typeof CreatePromotionBodySchema>;
export type UpdatePromotionInput = z.infer<typeof UpdatePromotionBodySchema>;
