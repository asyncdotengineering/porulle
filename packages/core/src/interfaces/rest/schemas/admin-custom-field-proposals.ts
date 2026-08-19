import { createRoute, z } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

const ProposalResponse = z.object({
  data: z.object({
    items: z.array(z.any()),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  }),
});

const ListQuery = z.object({
  entityType: z.string().min(1).optional(),
  page: z.string().max(10).optional(),
  limit: z.string().max(10).optional(),
});

export const listCustomFieldProposalsRoute = createRoute({
  method: "get",
  path: "/custom-field-proposals",
  tags: ["Admin"],
  summary: "List proposed custom-field values",
  request: { query: ListQuery },
  responses: {
    200: { content: { "application/json": { schema: ProposalResponse } }, description: "Proposed custom fields." },
    ...errorResponses,
  },
});
