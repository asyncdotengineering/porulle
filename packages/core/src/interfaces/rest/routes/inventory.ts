import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import {
  inventoryAdjustRoute,
  inventoryReserveRoute,
  inventoryReleaseRoute,
  createWarehouseRoute,
  inventoryCheckRoute,
  listWarehousesRoute,
  listInventoryLevelsRoute,
} from "../schemas/inventory.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";

export function inventoryRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // Inventory levels listing requires inventory:read
  router.use("/levels", requirePerm("inventory:read"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listInventoryLevelsRoute, async (c) => {
    const actor = c.get("actor");
    const warehouseId = c.req.query("warehouseId");
    const entityId = c.req.query("entityId");
    const result = await kernel.services.inventory.listLevels(
      {
        ...(warehouseId ? { warehouseId } : {}),
        ...(entityId ? { entityId } : {}),
      },
      actor,
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(inventoryCheckRoute, async (c) => {
    const entityIds = (c.req.query("entityIds") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const result = await kernel.services.inventory.checkMultiple(
      entityIds,
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(inventoryAdjustRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await kernel.services.inventory.adjust(body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(inventoryReserveRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await kernel.services.inventory.reserve(body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: { reserved: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(inventoryReleaseRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await kernel.services.inventory.release(body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: { released: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createWarehouseRoute, async (c) => {
    const body = c.req.valid("json") as Parameters<typeof kernel.services.inventory.createWarehouse>[0];
    const actor = c.get("actor");
    const result = await kernel.services.inventory.createWarehouse(body, actor);
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listWarehousesRoute, async (c) => {
    const actor = c.get("actor");
    const result = await kernel.services.inventory.listWarehouses(actor);
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  return router;
}
