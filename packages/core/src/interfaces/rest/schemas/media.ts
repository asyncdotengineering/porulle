import { z, createRoute } from "@hono/zod-openapi";
import { ErrorSchema, errorResponses } from "./shared.js";

// ─── Request Schema ──────────────────────────────────────────────────────────

export const AttachMediaBodySchema = z.object({
  mediaAssetId: z.string().openapi({ example: "asset-uuid" }),
  entityId: z.string().openapi({ example: "product-uuid" }),
  role: z.enum(["primary", "gallery", "thumbnail", "video", "document"]).openapi({ example: "primary" }),
  variantId: z.string().optional(),
  sortOrder: z.number().optional().openapi({ example: 0 }),
}).openapi("AttachMediaRequest");

// ─── Route Definitions ──────────────────────────────────────────────────────

export const getMediaRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Media"],
  summary: "Get a media asset (redirects to URL)",
  request: {
    params: z.object({
      id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
    query: z.object({
      signed: z.string().optional().openapi({ example: "true" }),
    }),
  },
  responses: {
    302: { description: "Redirect to media URL" },
    ...errorResponses,
  },
});

export const deleteMediaRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Media"],
  summary: "Delete a media asset",
  request: {
    params: z.object({
      id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.object({ deleted: z.literal(true) }) }) } },
      description: "Media deleted.",
    },
    ...errorResponses,
  },
});

export const attachMediaRoute = createRoute({
  method: "post",
  path: "/attach",
  tags: ["Media"],
  summary: "Attach a media asset to an entity",
  description: "Links an uploaded media asset to a catalog entity (product, variant, etc.).",
  request: {
    body: {
      content: {
        "application/json": { schema: AttachMediaBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: z.object({ attached: z.literal(true) }) }) } },
      description: "Media attached to entity.",
    },
    ...errorResponses,
  },
});
