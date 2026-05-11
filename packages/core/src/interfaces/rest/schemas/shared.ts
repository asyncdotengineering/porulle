import { z } from "@hono/zod-openapi";

// ─── Error Response ──────────────────────────────────────────────────────────

export const ErrorSchema = z.object({
  error: z.object({
    code: z.string().openapi({ example: "VALIDATION_FAILED" }),
    message: z.string().openapi({ example: "cartId: Invalid uuid" }),
  }),
}).openapi("Error");

// ─── Pagination ──────────────────────────────────────────────────────────────

export const PaginationQuerySchema = z.object({
  page: z.string().optional().openapi({ example: "1" }),
  limit: z.string().optional().openapi({ example: "20" }),
});

export const PaginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number().optional(),
}).openapi("PaginationMeta");

// ─── Common Params ───────────────────────────────────────────────────────────

export const UuidParamSchema = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

export const IdOrSlugParamSchema = z.object({
  idOrSlug: z.string().min(1).openapi({ example: "my-product" }),
});

// ─── Common Responses ────────────────────────────────────────────────────────

export const DeletedResponseSchema = z.object({
  data: z.object({ deleted: z.literal(true) }),
}).openapi("DeletedResponse");

export const errorResponses = {
  400: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Business logic error.",
  },
  401: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Authentication required.",
  },
  403: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Insufficient permissions.",
  },
  404: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Resource not found.",
  },
  422: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "Validation error.",
  },
} as const;
