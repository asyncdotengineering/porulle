import { z, createRoute } from "@hono/zod-openapi";
import { CatalogEntitySchema } from "./responses.js";

// ─── Route Definitions ──────────────────────────────────────────────────────

export const searchRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Search catalog entities",
  description:
    "Attribute filters use repeatable `attr.<name>=<value>` query parameters: repeated values for one name are ORed, distinct names are ANDed. Attribute names must match `^[A-Za-z0-9_-]+$`; anything else returns 422. Request attribute facet counts by naming the attribute in `facets`.",
  request: {
    query: z.object({
      q: z.string().max(500).optional(),
      type: z.string().max(100).optional(),
      category: z.string().max(200).optional(),
      brand: z.string().max(200).optional(),
      status: z.string().max(50).optional(),
      page: z.string().max(10).optional(),
      limit: z.string().max(10).optional(),
      facets: z.string().max(500).optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({
        data: z.array(CatalogEntitySchema),
        meta: z.object({
          pagination: z.object({
            page: z.number(),
            limit: z.number(),
            total: z.number().optional(),
          }),
        }).optional(),
      }) } },
      description: "Search results",
    },
  },
});

export const suggestRoute = createRoute({
  method: "get",
  path: "/suggest",
  tags: ["Search"],
  summary: "Get search suggestions",
  request: {
    query: z.object({
      prefix: z.string().max(200).optional(),
      type: z.string().max(100).optional(),
      limit: z.string().max(10).optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(z.object({ id: z.string(), slug: z.string(), title: z.string().optional() })) }) } },
      description: "Suggestions",
    },
  },
});
