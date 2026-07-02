import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ReportParamsSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/).openapi({ example: "daily-journal" }),
});

const ReportQuerySchema = z.object({
  date: z.string().regex(DATE).optional().openapi({ description: "Local calendar date (single-day reports)." }),
  from: z.string().regex(DATE).optional().openapi({ description: "Local range start, inclusive." }),
  to: z.string().regex(DATE).optional().openapi({ description: "Local range end, inclusive." }),
});

const DataResponse = z.object({ data: z.any() }).openapi("AnalyticsReportResponse");

export const listReportsRoute = createRoute({
  method: "get",
  path: "/reports",
  tags: ["Analytics"],
  summary: "List the canned retail reports",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Available reports." },
    ...errorResponses,
  },
});

export const getReportRoute = createRoute({
  method: "get",
  path: "/reports/{name}",
  tags: ["Analytics"],
  summary: "Run a canned retail report (calendar math in the store's timezone)",
  request: { params: ReportParamsSchema, query: ReportQuerySchema },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Report result." },
    ...errorResponses,
  },
});
