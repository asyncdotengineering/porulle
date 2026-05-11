import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import { changeOrderStatusRoute, listOrdersRoute, getOrderRoute, getOrderFulfillmentsRoute } from "../schemas/orders.js";
import { type AppEnv, isUUID, mapErrorToResponse, mapErrorToStatus, parsePagination } from "../utils.js";

export function orderRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listOrdersRoute, async (c) => {
    const pagination = parsePagination(c.req.query());
    const status = c.req.query("status");
    const result = await kernel.services.orders.list(
      {
        page: pagination.page,
        limit: pagination.limit,
        ...(status !== undefined ? { status } : {}),
      },
      c.get("actor"),
    );

    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({
      data: result.value.items,
      meta: {
        pagination: result.value.pagination,
      },
    });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getOrderRoute, async (c) => {
    const idOrNumber = c.req.param("idOrNumber");
    const result = isUUID(idOrNumber)
      ? await kernel.services.orders.getById(idOrNumber, c.get("actor"))
      : await kernel.services.orders.getByNumber(idOrNumber, c.get("actor"));

    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (200 | 400 | 404). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(changeOrderStatusRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await kernel.services.orders.changeStatus(
      {
        orderId: c.req.param("id"),
        newStatus: body.status,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      },
      c.get("actor"),
    );

    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getOrderFulfillmentsRoute, async (c) => {
    const orderId = c.req.param("id");
    const actor = c.get("actor");

    // Verify the order exists and the actor has access before returning fulfillments
    const orderResult = isUUID(orderId)
      ? await kernel.services.orders.getById(orderId, actor)
      : await kernel.services.orders.getByNumber(orderId, actor);

    if (!orderResult.ok) return c.json(mapErrorToResponse(orderResult.error), mapErrorToStatus(orderResult.error));

    const result = await kernel.services.fulfillment.getByOrderId(orderResult.value.id);
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  return router;
}
