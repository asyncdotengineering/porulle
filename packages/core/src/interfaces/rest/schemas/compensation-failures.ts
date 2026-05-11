import { z, createRoute } from "@hono/zod-openapi";

const OriginalErrorDigest = z.object({
  message: z.string(),
  code: z.string().optional(),
});

const CompensationErrorDigest = z.object({
  message: z.string(),
});

export const CompensationFailureDigestSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  correlationId: z.string(),
  chainName: z.string(),
  stepName: z.string(),
  originalError: OriginalErrorDigest,
  compensationError: CompensationErrorDigest,
  occurredAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolutionNotes: z.string().nullable(),
});

export const listCompensationFailuresRoute = createRoute({
  method: "get",
  path: "/compensation-failures",
  tags: ["Admin Compensation"],
  summary: "List compensation failures",
  request: {
    query: z.object({
      resolved: z.enum(["true", "false", "all"]).optional().openapi({
        description: "Filter by resolution state (default: false)",
        example: "false",
      }),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(CompensationFailureDigestSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated compensation failures",
    },
  },
});

export const resolveCompensationFailureRoute = createRoute({
  method: "post",
  path: "/compensation-failures/{id}/resolve",
  tags: ["Admin Compensation"],
  summary: "Mark a compensation failure resolved",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ example: "failure-uuid" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            notes: z.string().max(2000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            failure: CompensationFailureDigestSchema,
          }),
        },
      },
      description: "Failure marked resolved",
    },
  },
});
