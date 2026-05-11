import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import type {
  CreateEntityInput,
  UpdateEntityInput,
  CreateCategoryInput,
  UpdateCategoryInput,
  CreateBrandInput,
  UpdateBrandInput,
  CreateOptionTypeInput,
  CreateOptionValueInput,
  CreateVariantInput,
} from "../../../modules/catalog/schemas.js";
import type {
  SetAttributesInput,
  VariantGenerationStrategy,
} from "../../../modules/catalog/service.js";
import {
  listEntitiesRoute,
  getEntityRoute,
  getEntityAttributesRoute,
  listCategoriesRoute,
  listBrandsRoute,
  deleteEntityRoute,
  deleteCategoryRoute,
  deleteBrandRoute,
  removeEntityFromCategoryRoute,
  removeEntityFromBrandRoute,
  publishEntityRoute,
  archiveEntityRoute,
  discontinueEntityRoute,
  addEntityToCategoryRoute,
  addEntityToBrandRoute,
  createEntityRoute,
  updateEntityRoute,
  setEntityAttributesRoute,
  createCategoryRoute,
  updateCategoryRoute,
  createBrandRoute,
  updateBrandRoute,
  createOptionTypeRoute,
  createOptionValueRoute,
  createVariantRoute,
  generateVariantsRoute,
} from "../schemas/catalog.js";
import {
  type AppEnv,
  mapErrorToResponse,
  mapErrorToStatus,
  parseInclude,
  parsePagination,
  parseSort,
} from "../utils.js";

export function catalogRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listEntitiesRoute, async (c) => {
    try {
      const include = parseInclude(c.req.query("include"));
      const pagination = parsePagination(c.req.query());
      const filter: Record<string, string> = {};
      const type = c.req.query("type");
      const status = c.req.query("status");
      const category = c.req.query("category");
      const brand = c.req.query("brand");
      if (type) filter.type = type;
      if (status) filter.status = status;
      if (category) filter.category = category;
      if (brand) filter.brand = brand;

      const payload: Record<string, unknown> = {
        filter,
        pagination,
      };
      const sort = parseSort(c.req.query("sort"));
      if (sort) payload.sort = sort;

      const result = await kernel.services.catalog.list(payload, c.get("actor"));

      if (!result.ok) {
        return c.json(
          mapErrorToResponse(result.error),
          mapErrorToStatus(result.error),
        );
      }

      let withIncludes = result.value.items;
      if (include.size > 0) {
        const includeOptions = {
          includeAttributes: include.has("attributes"),
          includeVariants: include.has("variants"),
          includeOptionTypes: include.has("optionTypes"),
          includeCategories: include.has("categories"),
          includeBrands: include.has("brands"),
          includeMedia: include.has("media"),
          includeInventory: include.has("inventory"),
          includePricing: include.has("pricing"),
        };
        const hydrated = await Promise.all(
          result.value.items.map(async (item) => {
            const full = await kernel.services.catalog.getById(
              item.id,
              includeOptions,
            );
            return full.ok ? full.value : item;
          }),
        );
        withIncludes = hydrated;
      }

      return c.json({
        data: withIncludes,
        meta: {
          pagination: result.value.pagination,
        },
      });
    } catch (error) {
      console.error("[catalog] List failed:", error instanceof Error ? error.message : error);
      return c.json(mapErrorToResponse(error), mapErrorToStatus(error));
    }
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getEntityRoute, async (c) => {
    try {
      const idOrSlug = c.req.param("idOrSlug");
      const include = parseInclude(c.req.query("include"));

      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

      const includeOptions = {
        includeAttributes: include.has("attributes"),
        includeVariants: include.has("variants"),
        includeOptionTypes: include.has("optionTypes"),
        includeCategories: include.has("categories"),
        includeBrands: include.has("brands"),
        includeMedia: include.has("media"),
        includeInventory: include.has("inventory"),
        includePricing: include.has("pricing"),
      };

      const actor = c.get("actor");
      const result = isUUID
        ? await kernel.services.catalog.getById(idOrSlug, includeOptions, actor)
        : await kernel.services.catalog.getBySlug(idOrSlug, includeOptions, actor);

      if (!result.ok) {
        return c.json(
          mapErrorToResponse(result.error),
          mapErrorToStatus(result.error),
        );
      }

      return c.json({ data: result.value });
    } catch (error) {
      console.error("[catalog] Get entity failed:", error instanceof Error ? error.message : error);
      return c.json(mapErrorToResponse(error), mapErrorToStatus(error));
    }
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createEntityRoute, async (c) => {
    const result = await kernel.services.catalog.create(
      c.req.valid("json") as CreateEntityInput,
      c.get("actor"),
    );
    if (!result.ok) {
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    }
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateEntityRoute, async (c) => {
    const result = await kernel.services.catalog.update(
      c.req.param("id"),
      c.req.valid("json") as UpdateEntityInput,
      c.get("actor"),
    );
    if (!result.ok) {
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    }
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteEntityRoute, async (c) => {
    const result = await kernel.services.catalog.delete(
      c.req.param("id"),
      c.get("actor"),
    );
    if (!result.ok) {
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    }
    return c.json({ data: { deleted: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(publishEntityRoute, async (c) => {
    const result = await kernel.services.catalog.publish(
      c.req.param("id"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(archiveEntityRoute, async (c) => {
    const result = await kernel.services.catalog.archive(
      c.req.param("id"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(discontinueEntityRoute, async (c) => {
    const result = await kernel.services.catalog.discontinue(
      c.req.param("id"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(setEntityAttributesRoute, async (c) => {
    const result = await kernel.services.catalog.setAttributes(
      c.req.param("id"),
      c.req.param("locale"),
      c.req.valid("json") as unknown as SetAttributesInput, // Zod-validated; Hono returns Record<string, unknown>
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: { updated: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getEntityAttributesRoute, async (c) => {
    const result = await kernel.services.catalog.getAttributes(
      c.req.param("id"),
      c.req.param("locale"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listCategoriesRoute, async (c) => {
    const result = await kernel.services.catalog.listCategories({ actor: c.get("actor"), tx: null, requestId: "" });
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createCategoryRoute, async (c) => {
    const result = await kernel.services.catalog.createCategory(
      c.req.valid("json") as CreateCategoryInput,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateCategoryRoute, async (c) => {
    const result = await kernel.services.catalog.updateCategory(
      c.req.param("categoryId"),
      c.req.valid("json") as UpdateCategoryInput,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteCategoryRoute, async (c) => {
    const result = await kernel.services.catalog.deleteCategory(
      c.req.param("categoryId"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: { deleted: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(addEntityToCategoryRoute, async (c) => {
    const result = await kernel.services.catalog.addToCategory(
      c.req.param("id"),
      c.req.param("categoryId"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: { linked: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(removeEntityFromCategoryRoute, async (c) => {
    const result = await kernel.services.catalog.removeFromCategory(
      c.req.param("id"),
      c.req.param("categoryId"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: { unlinked: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listBrandsRoute, async (c) => {
    const result = await kernel.services.catalog.listBrands({ actor: c.get("actor"), tx: null, requestId: "" });
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createBrandRoute, async (c) => {
    const result = await kernel.services.catalog.createBrand(
      c.req.valid("json") as CreateBrandInput,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateBrandRoute, async (c) => {
    const result = await kernel.services.catalog.updateBrand(
      c.req.param("brandId"),
      c.req.valid("json") as UpdateBrandInput,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteBrandRoute, async (c) => {
    const result = await kernel.services.catalog.deleteBrand(
      c.req.param("brandId"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: { deleted: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(addEntityToBrandRoute, async (c) => {
    const result = await kernel.services.catalog.addToBrand(
      c.req.param("id"),
      c.req.param("brandId"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: { linked: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(removeEntityFromBrandRoute, async (c) => {
    const result = await kernel.services.catalog.removeFromBrand(
      c.req.param("id"),
      c.req.param("brandId"),
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: { unlinked: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createOptionTypeRoute, async (c) => {
    const result = await kernel.services.catalog.createOptionType(
      { ...(c.req.valid("json") as Record<string, unknown>), entityId: c.req.param("id") } as CreateOptionTypeInput,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createOptionValueRoute, async (c) => {
    const result = await kernel.services.catalog.createOptionValue(
      { ...(c.req.valid("json") as Record<string, unknown>), optionTypeId: c.req.param("optionTypeId") } as CreateOptionValueInput,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createVariantRoute, async (c) => {
    const result = await kernel.services.catalog.createVariant(
      { ...(c.req.valid("json") as Record<string, unknown>), entityId: c.req.param("id") } as CreateVariantInput,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(generateVariantsRoute, async (c) => {
    const body = c.req.valid("json") as VariantGenerationStrategy;
    const result = await kernel.services.catalog.generateVariants(
      c.req.param("id"),
      body,
      c.get("actor"),
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value }, 201);
  });

  return router;
}
