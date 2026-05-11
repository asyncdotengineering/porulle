import { z, createRoute } from "@hono/zod-openapi";
import { JobListResponse } from "./responses.js";

// ─── Route Definitions ──────────────────────────────────────────────────────

export const listFailedJobsRoute = createRoute({
  method: "get",
  path: "/jobs/failed",
  tags: ["Admin Jobs"],
  summary: "List failed jobs",
  request: {
    query: z.object({
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: JobListResponse } },
      description: "Failed jobs",
    },
  },
});

export const retryJobRoute = createRoute({
  method: "post",
  path: "/jobs/{id}/retry",
  tags: ["Admin Jobs"],
  summary: "Retry a failed job",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ example: "job-uuid" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.object({ retried: z.literal(true) }) }) } },
      description: "Job retried",
    },
  },
});
