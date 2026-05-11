import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../runtime/kernel.js";
import { assertPermission } from "../../auth/permissions.js";
import type { Actor } from "../../auth/types.js";
import type { AppEnv } from "./utils.js";
import {
  getProfileRoute,
  listAddressesRoute,
  listCustomerOrdersRoute,
  getCustomerOrderRoute,
  getOrderTrackingRoute,
  getOrderDownloadsRoute,
  listCoursesRoute,
  deleteAddressRoute,
  reorderRoute,
  updateProfileRoute,
  createAddressRoute,
} from "./schemas/customer-portal.js";
import { isUUID, mapErrorToStatus } from "./utils.js";

export function createCustomerPortalRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("*", async (c, next) => {
    if (!c.get("actor")) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Authentication required." } },
        401,
      );
    }
    await next();
  });

  /**
   * Resolves an actor whose userId is the customer profile UUID (not the Better Auth user ID).
   * Required so that `assertOwnership(actor, order.customerId)` compares UUIDs correctly,
   * since orders.customer_id stores the customer profile UUID, not the Better Auth string ID.
   */
  async function resolveCustomerActor(actor: Actor): Promise<Actor | null> {
    const customer = await kernel.services.customers.getByUserId(actor.userId, actor);
    if (!customer.ok) return null;
    return { ...actor, userId: customer.value.id };
  }

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getProfileRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const customer = await kernel.services.customers.getByUserId(actor.userId, actor);
    if (!customer.ok) return c.json({ error: customer.error }, 404);
    return c.json({ data: customer.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateProfileRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    assertPermission(actor, "customers:update:self");
    const result = await kernel.services.customers.updateByUserId(
      actor.userId,
      c.req.valid("json") as Parameters<typeof kernel.services.customers.updateByUserId>[1],
      actor,
    );
    if (!result.ok) return c.json({ error: result.error }, 422);
    return c.json({ data: result.value });
  });

  router.openapi(listAddressesRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const addresses = await kernel.services.customers.getAddresses(
      actor.userId,
      actor,
    );
    return c.json({ data: addresses.ok ? addresses.value : [] });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createAddressRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const result = await kernel.services.customers.addAddress(
      actor.userId,
      c.req.valid("json") as Parameters<typeof kernel.services.customers.addAddress>[1],
      actor,
    );
    if (!result.ok) return c.json({ error: result.error }, 422);
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteAddressRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const result = await kernel.services.customers.deleteAddress(
      actor.userId,
      c.req.param("id"),
      actor,
    );
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json({ data: { deleted: true } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listCustomerOrdersRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const status = c.req.query("status");
    // Resolve customer profile UUID from Better Auth userId
    const customerResult = await kernel.services.customers.getByUserId(actor.userId, actor);
    if (!customerResult.ok) return c.json({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } });
    const result = await kernel.services.orders.listByCustomer(customerResult.value.id, {
      page: Number.parseInt(c.req.query("page") ?? "1", 10),
      limit: Number.parseInt(c.req.query("limit") ?? "20", 10),
      ...(status !== undefined ? { status } : {}),
    });
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ data: result.value.items, meta: result.value.pagination });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getCustomerOrderRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const id = c.req.param("idOrNumber");
    const customerActor = await resolveCustomerActor(actor);
    if (!customerActor) return c.json({ error: { code: "NOT_FOUND", message: "Customer profile not found." } }, 404);
    const result = isUUID(id)
      ? await kernel.services.orders.getById(id, customerActor)
      : await kernel.services.orders.getByNumber(id, customerActor);

    if (!result.ok)
      return c.json({ error: result.error }, mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getOrderTrackingRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const id = c.req.param("idOrNumber");
    const customerActor = await resolveCustomerActor(actor);
    if (!customerActor) return c.json({ error: { code: "NOT_FOUND", message: "Customer profile not found." } }, 404);

    const orderResult = isUUID(id)
      ? await kernel.services.orders.getById(id, customerActor)
      : await kernel.services.orders.getByNumber(id, customerActor);

    if (!orderResult.ok) {
      return c.json(
        { error: orderResult.error },
        mapErrorToStatus(orderResult.error),
      );
    }

    const fulfillments = await kernel.services.fulfillment.getByOrderId(
      orderResult.value.id,
    );
    if (!fulfillments.ok) return c.json({ error: fulfillments.error }, 500);

    return c.json({
      data: fulfillments.value.map((item) => ({
        fulfillmentId: item.id,
        status: item.status,
        carrier: item.carrier ?? null,
        trackingNumber: item.trackingNumber ?? null,
        trackingUrl: item.trackingUrl ?? null,
        estimatedDelivery: item.estimatedDelivery ?? null,
        shippedAt: item.shippedAt ?? null,
        deliveredAt: item.deliveredAt ?? null,
        lineItems: item.lineItems,
      })),
    });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getOrderDownloadsRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const customerActor = await resolveCustomerActor(actor);
    if (!customerActor) return c.json({ error: { code: "NOT_FOUND", message: "Customer profile not found." } }, 404);
    const orderResult = await kernel.services.orders.getById(
      c.req.param("orderId"),
      customerActor,
    );
    if (!orderResult.ok) {
      return c.json(
        { error: orderResult.error },
        mapErrorToStatus(orderResult.error),
      );
    }

    const digitalItems = orderResult.value.lineItems.filter(
      (lineItem) => lineItem.entityType === "digitalDownload",
    );

    const downloads = await Promise.all(
      digitalItems.map(async (lineItem) => {
        const result = await kernel.services.fulfillment.getDownloadUrl(
          orderResult.value.id,
          lineItem.id,
          actor.userId,
          actor,
        );

        return {
          lineItemId: lineItem.id,
          title: lineItem.title,
          downloadUrl: result.ok ? result.value.url : null,
          downloadsRemaining: result.ok ? result.value.remaining : 0,
          expiresAt: result.ok ? result.value.expiresAt : null,
        };
      }),
    );

    return c.json({ data: downloads });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listCoursesRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const result = await kernel.services.fulfillment.getDigitalAccess(
      actor.userId,
      "course",
    );
    if (!result.ok) return c.json({ error: result.error }, 500);

    return c.json({
      data: result.value.map((item) => ({
        entityId: item.entityId,
        title: item.title,
        accessGrantedAt: item.grantedAt,
        accessExpiresAt: item.expiresAt,
        isActive: item.isActive,
        orderId: item.orderId,
      })),
    });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(reorderRoute, async (c) => {
    const actor = c.get("actor") as Actor;
    const customerActor = await resolveCustomerActor(actor);
    if (!customerActor) return c.json({ error: { code: "NOT_FOUND", message: "Customer profile not found." } }, 404);
    const orderResult = await kernel.services.orders.getById(
      c.req.param("orderId"),
      customerActor,
    );
    if (!orderResult.ok) {
      return c.json(
        { error: orderResult.error },
        mapErrorToStatus(orderResult.error),
      );
    }

    const cartResult = await kernel.services.cart.create(
      {
        customerId: actor.userId,
        currency: orderResult.value.currency,
      },
      actor,
    );

    if (!cartResult.ok) return c.json({ error: cartResult.error }, 500);

    const addResults = await Promise.all(
      orderResult.value.lineItems.map((lineItem) =>
        kernel.services.cart.addItem(
          {
            cartId: cartResult.value.id,
            entityId: lineItem.entityId,
            quantity: lineItem.quantity,
            unitPriceSnapshot: lineItem.unitPrice,
            currency: orderResult.value.currency,
            ...(lineItem.variantId != null
              ? { variantId: lineItem.variantId }
              : {}),
          },
          actor,
        ),
      ),
    );

    const failures = addResults
      .map((item, index) =>
        item.ok
          ? null
          : {
              item: orderResult.value.lineItems[index]?.title ?? "unknown",
              reason: item.error.message,
            },
      )
      .filter(Boolean);

    return c.json(
      {
        data: {
          cartId: cartResult.value.id,
          itemsAdded: addResults.filter((item) => item.ok).length,
          itemsFailed: failures,
        },
      },
      201,
    );
  });

  return router;
}
