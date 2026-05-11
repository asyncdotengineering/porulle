import { z, createRoute } from "@hono/zod-openapi";
import { ErrorSchema, errorResponses, UuidParamSchema, DeletedResponseSchema } from "./shared.js";
import { CartResponse } from "./responses.js";
import {
  CreateCartBodySchema,
  AddCartItemBodySchema,
  UpdateCartItemQuantityBodySchema,
} from "../../../modules/cart/schemas.js";

export { CreateCartBodySchema, AddCartItemBodySchema, UpdateCartItemQuantityBodySchema };

// ─── Response Schemas ───────────────────────────────────────────────────────

export const CartResponseSchema = CartResponse;

// ─── Path Params ────────────────────────────────────────────────────────────

const CartIdParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

const CartItemParams = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  itemId: z.uuid().openapi({ example: "660e8400-e29b-41d4-a716-446655440000" }),
});

// ─── Route Definitions ──────────────────────────────────────────────────────

export const getCartRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Carts"],
  summary: "Get a cart by ID",
  request: { params: CartIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: CartResponseSchema } },
      description: "Cart retrieved.",
    },
    ...errorResponses,
  },
});

export const removeCartItemRoute = createRoute({
  method: "delete",
  path: "/{id}/items/{itemId}",
  tags: ["Carts"],
  summary: "Remove an item from a cart",
  request: { params: CartItemParams },
  responses: {
    200: {
      content: { "application/json": { schema: DeletedResponseSchema } },
      description: "Item removed.",
    },
    ...errorResponses,
  },
});

export const createCartRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Carts"],
  summary: "Create a new cart",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateCartBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CartResponseSchema } },
      description: "Cart created successfully.",
    },
    ...errorResponses,
  },
});

export const addCartItemRoute = createRoute({
  method: "post",
  path: "/{id}/items",
  tags: ["Carts"],
  summary: "Add an item to a cart",
  request: {
    params: CartIdParam,
    body: {
      content: {
        "application/json": { schema: AddCartItemBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CartResponseSchema } },
      description: "Item added to cart.",
    },
    ...errorResponses,
  },
});

export const updateCartItemQuantityRoute = createRoute({
  method: "patch",
  path: "/{id}/items/{itemId}",
  tags: ["Carts"],
  summary: "Update the quantity of a cart line item",
  request: {
    params: CartItemParams,
    body: {
      content: {
        "application/json": { schema: UpdateCartItemQuantityBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CartResponseSchema } },
      description: "Cart item quantity updated.",
    },
    ...errorResponses,
  },
});
