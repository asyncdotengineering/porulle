import { z, createRoute } from "@hono/zod-openapi";

// ─── Route Definitions ──────────────────────────────────────────────────────

export const listAuditRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Audit"],
  summary: "List audit entries",
  request: {
    query: z.object({
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      event: z.string().optional(),
      actorId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }) } },
      description: "Audit entries",
    },
  },
});

export const listEntityAuditRoute = createRoute({
  method: "get",
  path: "/{entityType}/{entityId}",
  tags: ["Audit"],
  summary: "List audit history for a specific entity",
  request: {
    params: z.object({
      entityType: z.string().min(1).openapi({ example: "order" }),
      entityId: z.string().min(1).openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }) } },
      description: "Entity audit history",
    },
  },
});
