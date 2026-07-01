import { z } from "@hono/zod-openapi";

// ─── Cart Body Schemas (single source of truth) ─────────────────────────────

export const CreateCartBodySchema = z.object({
  customerId: z.string().optional().openapi({ example: "customer-uuid" }),
  currency: z.string().length(3).optional().openapi({ example: "USD" }),
  email: z.email().optional().openapi({ example: "shopper@example.com" }),
}).openapi("CreateCartRequest");

export const AddCartItemBodySchema = z.object({
  entityId: z.string().openapi({ example: "product-uuid" }),
  variantId: z.string().nullable().optional().openapi({ example: "variant-uuid" }),
  quantity: z.number().int().min(1).max(9999).openapi({ example: 1 }),
}).openapi("AddCartItemRequest");

export const UpdateCartItemQuantityBodySchema = z.object({
  quantity: z.number().int().min(1).max(9999).openapi({ example: 2 }),
}).openapi("UpdateCartItemQuantityRequest");

// ─── Derived Input Types ─────────────────────────────────────────────────────

export type CreateCartInput = z.infer<typeof CreateCartBodySchema> & {
  metadata?: Record<string, unknown>;
};

export type AddCartItemInput = z.infer<typeof AddCartItemBodySchema> & {
  cartId: string;
  unitPriceSnapshot?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
};

/** Hand-written: all fields come from path params + body; schema only has quantity. */
export interface UpdateCartItemInput {
  cartId: string;
  itemId: string;
  quantity: number;
}
