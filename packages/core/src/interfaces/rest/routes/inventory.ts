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

  // Warehouse config + reservation are staff operations, never public. Gate them
  // at the route (reserve/release are also called internally by checkout with the
  // customer's actor, so the service itself must stay callable — the boundary is
  // the HTTP route). Blocks anonymous (401) and customers lacking the perm (403).
  router.use("/warehouses", requirePerm("inventory:read"));
  router.use("/reserve", requirePerm("inventory:adjust"));
  router.use("/release", requirePerm("inventory:adjust"));

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
    const result = await kernel.services.inventory.adjustDetailed(body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    const { level, before, after, delta, movementId } = result.value;
    // Additive: level fields (back-compat) plus before/after/delta/movementId.
    return c.json({ data: { ...level, before, after, delta, movementId } });
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
    // Creating a warehouse (write) needs the higher inventory:adjust perm; the
    // router.use above already requires inventory:read for the /warehouses path.
    const perms = (actor as { permissions?: string[] } | null)?.permissions ?? [];
    if (!(perms.includes("inventory:adjust") || perms.includes("inventory:*") || perms.includes("*:*"))) {
      return c.json({ error: { code: "FORBIDDEN", message: "Permission 'inventory:adjust' is required." } }, 403);
    }
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
