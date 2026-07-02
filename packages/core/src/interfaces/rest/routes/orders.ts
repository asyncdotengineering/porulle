import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import { changeOrderStatusRoute, listOrdersRoute, orderLookupRoute, getOrderRoute, getOrderFulfillmentsRoute, createOrderRoute, refundOrderRoute, captureOrderRoute, createOrderFulfillmentRoute, addOrderLineItemRoute, updateOrderLineItemRoute, removeOrderLineItemRoute, refundOrderLinesRoute, undoOrderRefundRoute, listOrderRefundsRoute, refundCapStatusRoute, createOrderNoteRoute, listOrderNotesRoute, deleteOrderNoteRoute, orderTimelineRoute } from "../schemas/orders.js";
import { type AppEnv, isUUID, mapErrorToResponse, mapErrorToStatus, parsePagination } from "../utils.js";
import type { CreateOrderInput } from "../../../modules/orders/service.js";

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

  // Registered before getOrderRoute so "/lookup" isn't matched as an idOrNumber.
  // @ts-expect-error -- openapi handler union return type
  router.openapi(orderLookupRoute, async (c) => {
    const q = c.req.query("q") ?? "";
    const fromRaw = c.req.query("from");
    const toRaw = c.req.query("to");
    const opts: { from?: Date; to?: Date } = {};
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (!Number.isNaN(d.getTime())) opts.from = d;
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (!Number.isNaN(d.getTime())) opts.to = d;
    }
    const result = await kernel.services.orders.lookup(q, opts, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
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

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createOrderRoute, async (c) => {
    const body = c.req.valid("json") as CreateOrderInput;
    const result = await kernel.services.orders.create(body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(refundOrderRoute, async (c) => {
    const body = c.req.valid("json") as { amount?: number; reason?: string } | undefined;
    const result = await kernel.services.orders.refund(
      c.req.param("id"),
      c.get("actor"),
      body?.reason ?? "refunded",
      undefined,
      body?.amount !== undefined ? { amount: body.amount } : undefined,
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // ── Notes + activity timeline (issue #56) ──────────────────────────

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createOrderNoteRoute, async (c) => {
    const body = c.req.valid("json") as { body: string; pinned?: boolean };
    const result = await kernel.services.orders.addNote(c.req.param("id"), body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listOrderNotesRoute, async (c) => {
    const result = await kernel.services.orders.listNotes(c.req.param("id"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteOrderNoteRoute, async (c) => {
    const result = await kernel.services.orders.deleteNote(
      c.req.param("id"),
      c.req.param("noteId"),
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(orderTimelineRoute, async (c) => {
    const result = await kernel.services.orders.timeline(c.req.param("id"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // ── Line-level refunds (issue #52) ─────────────────────────────────

  // @ts-expect-error -- openapi handler union return type
  router.openapi(refundCapStatusRoute, async (c) => {
    const result = await kernel.services.orders.refundCapStatus(c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(refundOrderLinesRoute, async (c) => {
    const body = c.req.valid("json") as { lines: Array<{ lineItemId: string; quantity: number }>; reason?: string };
    const result = await kernel.services.orders.refundLines(
      c.req.param("id"),
      body,
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(undoOrderRefundRoute, async (c) => {
    const result = await kernel.services.orders.undoRefund(
      c.req.param("id"),
      c.req.param("refundId"),
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listOrderRefundsRoute, async (c) => {
    const result = await kernel.services.orders.listRefunds(c.req.param("id"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(captureOrderRoute, async (c) => {
    const body = c.req.valid("json") as { amount?: number } | undefined;
    const result = await kernel.services.orders.capture(
      c.req.param("id"),
      c.get("actor"),
      body?.amount !== undefined ? { amount: body.amount } : undefined,
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(addOrderLineItemRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await kernel.services.orders.addLineItem(
      c.req.param("id"),
      body,
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateOrderLineItemRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await kernel.services.orders.updateOrderLineItem(
      c.req.param("id"),
      c.req.param("lineItemId"),
      body,
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(removeOrderLineItemRoute, async (c) => {
    const result = await kernel.services.orders.removeLineItem(
      c.req.param("id"),
      c.req.param("lineItemId"),
      c.get("actor"),
    );
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
  router.openapi(createOrderFulfillmentRoute, async (c) => {
    const actor = c.get("actor");
    const orderId = c.req.param("id");

    // Verify the order exists and the actor has access before recording
    const orderResult = await kernel.services.orders.getById(orderId, actor);
    if (!orderResult.ok) return c.json(mapErrorToResponse(orderResult.error), mapErrorToStatus(orderResult.error));

    const body = c.req.valid("json") as {
      lineItems: Array<{ orderLineItemId: string; quantity: number }>;
      carrier?: string;
      trackingNumber?: string;
      trackingUrl?: string;
      type?: string;
      status?: string;
      metadata?: Record<string, unknown>;
    };
    const result = await kernel.services.fulfillment.createFulfillment(
      { ...body, orderId: orderResult.value.id },
      actor,
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
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
