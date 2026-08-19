import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../../runtime/kernel.js";
import type {
  CreateEntityFieldDefinitionInput,
  UpdateEntityFieldDefinitionInput,
} from "../../../../modules/catalog/service.js";
import {
  archiveEntityFieldDefinitionRoute,
  createEntityFieldDefinitionRoute,
  listEntityFieldDefinitionsRoute,
  updateEntityFieldDefinitionRoute,
} from "../../schemas/admin-entity-field-definitions.js";
import {
  type AppEnv,
  mapErrorToResponse,
  mapErrorToStatus,
  requirePerm,
} from "../../utils.js";

export function adminEntityFieldDefinitionRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/entity-field-definitions", requirePerm("catalog:update"));
  router.use("/entity-field-definitions/:id", requirePerm("catalog:update"));
  router.use(
    "/entity-field-definitions/:id/archive",
    requirePerm("catalog:update"),
  );

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createEntityFieldDefinitionRoute, async (c) => {
    const result = await kernel.services.catalog.createEntityFieldDefinition(
      c.req.valid("json") as CreateEntityFieldDefinitionInput,
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
  router.openapi(listEntityFieldDefinitionsRoute, async (c) => {
    const entityType = c.req.query("entityType");
    const result = await kernel.services.catalog.listEntityFieldDefinitions(
      c.get("actor"),
      entityType,
    );
    if (!result.ok)
      return c.json(
        mapErrorToResponse(result.error),
        mapErrorToStatus(result.error),
      );
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateEntityFieldDefinitionRoute, async (c) => {
    const result = await kernel.services.catalog.updateEntityFieldDefinition(
      c.req.param("id"),
      c.req.valid("json") as UpdateEntityFieldDefinitionInput,
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
  router.openapi(archiveEntityFieldDefinitionRoute, async (c) => {
    const result = await kernel.services.catalog.archiveEntityFieldDefinition(
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

  return router;
}
