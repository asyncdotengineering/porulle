import { z } from "@hono/zod-openapi";

// ─── Cart Body Schemas (single source of truth) ─────────────────────────────

export const CreateCartBodySchema = z.object({
  customerId: z.string().optional().openapi({ example: "customer-uuid" }),
  currency: z.string().length(3).optional().openapi({ example: "USD" }),
  email: z.email().optional().openapi({ example: "shopper@example.com" }),
}).openapi("CreateCartRequest");

/**
 * What a storefront records about why a line was added (the search that showed it, whether it is a gift). It is the caller's own
 * annotation, never read by pricing, stock or permissions, and the order line carries it on. Flat and bounded: a line is not a
 * place for a blob.
 */
export const CartLineMetadataSchema = z
  .record(z.string().min(1).max(64), z.union([z.string().max(256), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 16, { message: "metadata may have at most 16 keys" })
  .openapi({ example: { requestId: "6f1c2a7e-0000-4000-8000-000000000001", forSomeoneElse: true } });

export const AddCartItemBodySchema = z.object({
  entityId: z.string().openapi({ example: "product-uuid" }),
  variantId: z.string().nullable().optional().openapi({ example: "variant-uuid" }),
  quantity: z.number().int().min(1).max(9999).openapi({ example: 1 }),
  metadata: CartLineMetadataSchema.optional(),
}).openapi("AddCartItemRequest");

export const UpdateCartItemQuantityBodySchema = z.object({
  quantity: z.number().int().min(1).max(9999).openapi({ example: 2 }),
}).openapi("UpdateCartItemQuantityRequest");

// ─── Derived Input Types ─────────────────────────────────────────────────────

export type CreateCartInput = z.infer<typeof CreateCartBodySchema> & {
  metadata?: Record<string, unknown>;
};

export type AddCartItemInput = Omit<z.infer<typeof AddCartItemBodySchema>, "metadata"> & {
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
