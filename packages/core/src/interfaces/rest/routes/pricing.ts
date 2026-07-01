import { OpenAPIHono } from "@hono/zod-openapi";
import { resolveOrgId } from "../../../auth/org.js";
import { CommerceValidationError } from "../../../kernel/errors.js";
import type { DrizzleDatabase } from "../../../kernel/database/drizzle-db.js";
import { CatalogRepository } from "../../../modules/catalog/repository/index.js";
import type { Kernel } from "../../../runtime/kernel.js";
import { setBasePriceRoute, createModifierRoute, listPricesRoute, listModifiersRoute, updateModifierRoute, deleteModifierRoute } from "../schemas/pricing.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";

export function pricingRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/prices", requirePerm("pricing:manage"));

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (201 | 400 | 422). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(setBasePriceRoute, async (c) => {
    const actor = c.get("actor");
    const result = await kernel.services.pricing.setBasePrice(c.req.valid("json"), actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listPricesRoute, async (c) => {
    const entityId = c.req.query("entityId");
    const variantId = c.req.query("variantId");
    const currency = c.req.query("currency");
    const customerGroupId = c.req.query("customerGroupId");
    const actor = c.get("actor");

    const result = await kernel.services.pricing.listPrices({
      ...(entityId !== undefined ? { entityId } : {}),
      ...(variantId !== undefined ? { variantId } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(customerGroupId !== undefined ? { customerGroupId } : {}),
    }, actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value });
  });

  router.use("/modifiers", requirePerm("pricing:manage"));
  router.use("/modifiers/:id", requirePerm("pricing:manage"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listModifiersRoute, async (c) => {
    const actor = c.get("actor");
    const entityId = c.req.query("entityId");
    const currency = c.req.query("currency");
    const active = c.req.query("active");

    const result = await kernel.services.pricing.listModifiers({
      ...(entityId !== undefined ? { entityId } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(active === "true" ? { active: true } : {}),
    }, actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateModifierRoute, async (c) => {
    const actor = c.get("actor");
    const result = await kernel.services.pricing.updateModifier(
      c.req.param("id"),
      c.req.valid("json"),
      actor,
    );
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteModifierRoute, async (c) => {
    const actor = c.get("actor");
    const result = await kernel.services.pricing.deleteModifier(c.req.param("id"), actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (201 | 400 | 422). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(createModifierRoute, async (c) => {
    const actor = c.get("actor");
    const input = c.req.valid("json");

    if (input.entityId) {
      const catalogRepo = new CatalogRepository(kernel.database.db as DrizzleDatabase);
      const orgId = resolveOrgId(actor);
      const entity = await catalogRepo.findEntityById(input.entityId);
      if (!entity || entity.organizationId !== orgId) {
        return c.json(
          mapErrorToResponse(
            new CommerceValidationError("entityId does not belong to this organization."),
          ),
          422,
        );
      }
    }

    const result = await kernel.services.pricing.createModifier(input, actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value }, 201);
  });

  return router;
}
