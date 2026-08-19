import { createRoute, z } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

const FieldType = z.enum([
  "text",
  "number",
  "boolean",
  "date",
  "json",
  "relation",
  "select",
]);

const CreateBody = z
  .object({
    entityType: z.string().min(1),
    name: z.string().min(1),
    type: FieldType,
    unit: z.string().nullable().optional(),
    options: z.array(z.string()).nullable().optional(),
    target: z.string().nullable().optional(),
    filterable: z.boolean().optional(),
    localized: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("CreateEntityFieldDefinitionRequest");

const UpdateBody = z
  .object({
    entityType: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    type: FieldType.optional(),
    unit: z.string().nullable().optional(),
    options: z.array(z.string()).nullable().optional(),
    target: z.string().nullable().optional(),
    filterable: z.boolean().optional(),
    localized: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("UpdateEntityFieldDefinitionRequest");

const IdParam = z.object({ id: z.uuid() });
const ListQuery = z.object({ entityType: z.string().min(1).optional() });
const DataResponse = z
  .object({ data: z.any() })
  .openapi("EntityFieldDefinitionResponse");

export const createEntityFieldDefinitionRoute = createRoute({
  method: "post",
  path: "/entity-field-definitions",
  tags: ["Admin"],
  summary: "Create a runtime entity field definition",
  request: {
    body: {
      content: { "application/json": { schema: CreateBody } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: DataResponse } },
      description: "Definition created.",
    },
    ...errorResponses,
  },
});

export const listEntityFieldDefinitionsRoute = createRoute({
  method: "get",
  path: "/entity-field-definitions",
  tags: ["Admin"],
  summary: "List runtime entity field definitions",
  request: { query: ListQuery },
  responses: {
    200: {
      content: { "application/json": { schema: DataResponse } },
      description: "Definitions.",
    },
    ...errorResponses,
  },
});

export const updateEntityFieldDefinitionRoute = createRoute({
  method: "patch",
  path: "/entity-field-definitions/{id}",
  tags: ["Admin"],
  summary: "Update a runtime entity field definition",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: UpdateBody } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: DataResponse } },
      description: "Definition updated.",
    },
    ...errorResponses,
  },
});

export const archiveEntityFieldDefinitionRoute = createRoute({
  method: "post",
  path: "/entity-field-definitions/{id}/archive",
  tags: ["Admin"],
  summary: "Archive a runtime entity field definition",
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: DataResponse } },
      description: "Definition archived.",
    },
    ...errorResponses,
  },
});

export type CreateEntityFieldDefinitionBody = z.infer<typeof CreateBody>;
export type UpdateEntityFieldDefinitionBody = z.infer<typeof UpdateBody>;
