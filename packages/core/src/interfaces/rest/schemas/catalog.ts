import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";
import { CatalogEntityResponse, CatalogEntityListResponse } from "./responses.js";
import {
  CreateEntityBodySchema,
  UpdateEntityBodySchema,
  SetAttributesBodySchema,
  CreateCategoryBodySchema,
  UpdateCategoryBodySchema,
  CreateBrandBodySchema,
  UpdateBrandBodySchema,
  CreateOptionTypeBodySchema,
  CreateOptionValueBodySchema,
  CreateVariantBodySchema,
  GenerateVariantsBodySchema,
} from "../../../modules/catalog/schemas.js";

// ─── Response Schemas ───────────────────────────────────────────────────────

const DataResponse = CatalogEntityResponse;
const DataWithPaginationResponse = CatalogEntityListResponse;

// ─── Path Params ────────────────────────────────────────────────────────────

const EntityIdOrSlugParam = z.object({
  idOrSlug: z.string().min(1).openapi({ example: "my-product" }),
});

const EntityIdParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

const EntityIdLocaleParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  locale: z.string().min(1).openapi({ example: "en" }),
});

const CategoryIdParam = z.object({
  categoryId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

const BrandIdParam = z.object({
  brandId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

const EntityCategoryParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  categoryId: z.uuid().openapi({ example: "660e8400-e29b-41d4-a716-446655440000" }),
});

const EntityBrandParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  brandId: z.uuid().openapi({ example: "660e8400-e29b-41d4-a716-446655440000" }),
});

// ─── GET Route Definitions ─────────────────────────────────────────────────

export const listEntitiesRoute = createRoute({
  method: "get",
  path: "/entities",
  tags: ["Catalog"],
  summary: "List catalog entities",
  request: {
    query: z.object({
      type: z.string().max(100).optional(),
      status: z.string().max(50).optional(),
      category: z.string().max(200).optional(),
      brand: z.string().max(200).optional(),
      include: z.string().max(200).optional(),
      sort: z.string().max(50).optional(),
      page: z.string().max(10).optional(),
      limit: z.string().max(10).optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataWithPaginationResponse } }, description: "Success" },
  },
});

export const getEntityRoute = createRoute({
  method: "get",
  path: "/entities/{idOrSlug}",
  tags: ["Catalog"],
  summary: "Get a catalog entity by ID or slug",
  request: {
    params: EntityIdOrSlugParam,
    query: z.object({ include: z.string().optional() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Success" },
    ...errorResponses,
  },
});

export const getEntityAttributesRoute = createRoute({
  method: "get",
  path: "/entities/{id}/attributes/{locale}",
  tags: ["Catalog"],
  summary: "Get entity attributes for a locale",
  request: { params: EntityIdLocaleParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Success" },
    ...errorResponses,
  },
});

export const listCategoriesRoute = createRoute({
  method: "get",
  path: "/categories",
  tags: ["Catalog"],
  summary: "List all categories",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Success" },
  },
});

export const listBrandsRoute = createRoute({
  method: "get",
  path: "/brands",
  tags: ["Catalog"],
  summary: "List all brands",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Success" },
  },
});

// ─── DELETE Route Definitions ──────────────────────────────────────────────

export const deleteEntityRoute = createRoute({
  method: "delete",
  path: "/entities/{id}",
  tags: ["Catalog"],
  summary: "Delete a catalog entity",
  request: { params: EntityIdParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ deleted: z.literal(true) }) }) } }, description: "Deleted" },
    ...errorResponses,
  },
});

export const deleteCategoryRoute = createRoute({
  method: "delete",
  path: "/categories/{categoryId}",
  tags: ["Catalog"],
  summary: "Delete a category",
  request: { params: CategoryIdParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ deleted: z.literal(true) }) }) } }, description: "Deleted" },
    ...errorResponses,
  },
});

export const deleteBrandRoute = createRoute({
  method: "delete",
  path: "/brands/{brandId}",
  tags: ["Catalog"],
  summary: "Delete a brand",
  request: { params: BrandIdParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ deleted: z.literal(true) }) }) } }, description: "Deleted" },
    ...errorResponses,
  },
});

export const removeEntityFromCategoryRoute = createRoute({
  method: "delete",
  path: "/entities/{id}/categories/{categoryId}",
  tags: ["Catalog"],
  summary: "Remove entity from category",
  request: { params: EntityCategoryParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ unlinked: z.literal(true) }) }) } }, description: "Unlinked" },
    ...errorResponses,
  },
});

export const removeEntityFromBrandRoute = createRoute({
  method: "delete",
  path: "/entities/{id}/brands/{brandId}",
  tags: ["Catalog"],
  summary: "Remove entity from brand",
  request: { params: EntityBrandParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ unlinked: z.literal(true) }) }) } }, description: "Unlinked" },
    ...errorResponses,
  },
});

// ─── No-body POST Route Definitions ────────────────────────────────────────

export const publishEntityRoute = createRoute({
  method: "post",
  path: "/entities/{id}/publish",
  tags: ["Catalog"],
  summary: "Publish a catalog entity",
  request: { params: EntityIdParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Published" },
    ...errorResponses,
  },
});

export const archiveEntityRoute = createRoute({
  method: "post",
  path: "/entities/{id}/archive",
  tags: ["Catalog"],
  summary: "Archive a catalog entity",
  request: { params: EntityIdParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Archived" },
    ...errorResponses,
  },
});

export const discontinueEntityRoute = createRoute({
  method: "post",
  path: "/entities/{id}/discontinue",
  tags: ["Catalog"],
  summary: "Discontinue a catalog entity",
  request: { params: EntityIdParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Discontinued" },
    ...errorResponses,
  },
});

export const addEntityToCategoryRoute = createRoute({
  method: "post",
  path: "/entities/{id}/categories/{categoryId}",
  tags: ["Catalog"],
  summary: "Add entity to a category",
  request: { params: EntityCategoryParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ linked: z.literal(true) }) }) } }, description: "Linked" },
    ...errorResponses,
  },
});

export const addEntityToBrandRoute = createRoute({
  method: "post",
  path: "/entities/{id}/brands/{brandId}",
  tags: ["Catalog"],
  summary: "Add entity to a brand",
  request: { params: EntityBrandParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ linked: z.literal(true) }) }) } }, description: "Linked" },
    ...errorResponses,
  },
});

// ─── Mutation Route Definitions ─────────────────────────────────────────────

const OptionTypeIdParam = z.object({
  optionTypeId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

export const createEntityRoute = createRoute({
  method: "post",
  path: "/entities",
  tags: ["Catalog"],
  summary: "Create a catalog entity",
  request: {
    body: {
      content: { "application/json": { schema: CreateEntityBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Created" },
    ...errorResponses,
  },
});

export const updateEntityRoute = createRoute({
  method: "patch",
  path: "/entities/{id}",
  tags: ["Catalog"],
  summary: "Update a catalog entity",
  request: {
    params: EntityIdParam,
    body: {
      content: { "application/json": { schema: UpdateEntityBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Updated" },
    ...errorResponses,
  },
});

export const setEntityAttributesRoute = createRoute({
  method: "put",
  path: "/entities/{id}/attributes/{locale}",
  tags: ["Catalog"],
  summary: "Set entity attributes for a locale",
  request: {
    params: EntityIdLocaleParam,
    body: {
      content: { "application/json": { schema: SetAttributesBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ updated: z.literal(true) }) }) } }, description: "Updated" },
    ...errorResponses,
  },
});

export const createCategoryRoute = createRoute({
  method: "post",
  path: "/categories",
  tags: ["Catalog"],
  summary: "Create a category",
  request: {
    body: {
      content: { "application/json": { schema: CreateCategoryBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Created" },
    ...errorResponses,
  },
});

export const updateCategoryRoute = createRoute({
  method: "patch",
  path: "/categories/{categoryId}",
  tags: ["Catalog"],
  summary: "Update a category",
  request: {
    params: CategoryIdParam,
    body: {
      content: { "application/json": { schema: UpdateCategoryBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Updated" },
    ...errorResponses,
  },
});

export const createBrandRoute = createRoute({
  method: "post",
  path: "/brands",
  tags: ["Catalog"],
  summary: "Create a brand",
  request: {
    body: {
      content: { "application/json": { schema: CreateBrandBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Created" },
    ...errorResponses,
  },
});

export const updateBrandRoute = createRoute({
  method: "patch",
  path: "/brands/{brandId}",
  tags: ["Catalog"],
  summary: "Update a brand",
  request: {
    params: BrandIdParam,
    body: {
      content: { "application/json": { schema: UpdateBrandBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Updated" },
    ...errorResponses,
  },
});

export const createOptionTypeRoute = createRoute({
  method: "post",
  path: "/entities/{id}/options",
  tags: ["Catalog"],
  summary: "Create an option type for an entity",
  request: {
    params: EntityIdParam,
    body: {
      content: { "application/json": { schema: CreateOptionTypeBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Created" },
    ...errorResponses,
  },
});

export const createOptionValueRoute = createRoute({
  method: "post",
  path: "/options/{optionTypeId}/values",
  tags: ["Catalog"],
  summary: "Create an option value",
  request: {
    params: OptionTypeIdParam,
    body: {
      content: { "application/json": { schema: CreateOptionValueBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Created" },
    ...errorResponses,
  },
});

export const createVariantRoute = createRoute({
  method: "post",
  path: "/entities/{id}/variants",
  tags: ["Catalog"],
  summary: "Create a variant for an entity",
  request: {
    params: EntityIdParam,
    body: {
      content: { "application/json": { schema: CreateVariantBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Created" },
    ...errorResponses,
  },
});

export const generateVariantsRoute = createRoute({
  method: "post",
  path: "/entities/{id}/variants/generate",
  tags: ["Catalog"],
  summary: "Generate variants from option combinations",
  request: {
    params: EntityIdParam,
    body: {
      content: { "application/json": { schema: GenerateVariantsBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Generated" },
    ...errorResponses,
  },
});
