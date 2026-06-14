import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import {
  listCustomersRoute,
  createCustomerRoute,
  getCustomerRoute,
  updateCustomerRoute,
  getCustomerOrdersRoute,
  getCustomerAddressesRoute,
  listInteractionsRoute,
  createInteractionRoute,
  updateInteractionRoute,
  deleteInteractionRoute,
} from "../schemas/customers.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, parsePagination, parseInclude, requirePerm } from "../utils.js";

export function customerRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // All customer admin routes require authentication + customers:read
  router.use("/*", requirePerm("customers:read"));
  router.use("/", requirePerm("customers:read"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listCustomersRoute, async (c) => {
    const actor = c.get("actor");
    const { page, limit } = parsePagination(c.req.query());

    const result = await kernel.services.customers.list(actor);
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));

    const all = result.value;
    const total = all.length;
    const start = (page - 1) * limit;
    const paged = all.slice(start, start + limit);

    return c.json({
      data: paged,
      meta: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createCustomerRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await kernel.services.customers.createWalkIn(body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getCustomerRoute, async (c) => {
    const { id } = c.req.valid("param");
    const actor = c.get("actor");
    const result = await kernel.services.customers.getById(id, actor);
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // PATCH requires customers:update (checked in handler since middleware can't distinguish methods)

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateCustomerRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor");
    // Strip undefined values — exactOptionalPropertyTypes requires omission, not undefined
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) updates[k] = v;
    }
    const replaceMetadata = c.req.query("metadataReplace") === "true";
    const result = await kernel.services.customers.update(id, updates, actor, undefined, {
      replaceMetadata,
    });
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getCustomerOrdersRoute, async (c) => {
    const { id } = c.req.valid("param");
    const actor = c.get("actor");
    const { page, limit } = parsePagination(c.req.query());
    const status = c.req.query("status") || undefined;
    const includeTotals = parseInclude(c.req.query("include")).has("totals");

    const result = await kernel.services.orders.listByCustomer(
      id,
      { page, limit, ...(status ? { status } : {}), ...(includeTotals ? { includeTotals: true } : {}) },
      actor,
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    if (includeTotals) {
      // Wrapped shape: { data: { items, totals } } (+ pagination meta).
      return c.json({
        data: { items: result.value.items, totals: result.value.totals },
        meta: { pagination: result.value.pagination },
      });
    }
    // Default (back-compat): flat array.
    return c.json({ data: result.value.items, meta: { pagination: result.value.pagination } });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getCustomerAddressesRoute, async (c) => {
    const { id } = c.req.valid("param");
    const actor = c.get("actor");

    // Get customer first, then use their userId for address lookup
    const customerResult = await kernel.services.customers.getById(id, actor);
    if (!customerResult.ok) return c.json(mapErrorToResponse(customerResult.error), mapErrorToStatus(customerResult.error));

    const addressResult = await kernel.services.customers.getAddresses(
      customerResult.value.userId,
      actor,
    );
    if (!addressResult.ok) return c.json(mapErrorToResponse(addressResult.error), mapErrorToStatus(addressResult.error));
    return c.json({ data: addressResult.value });
  });

  // ─── Customer interactions (#3) ──────────────────────────────────────────

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listInteractionsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const result = await kernel.services.customers.listInteractions(id, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createInteractionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await kernel.services.customers.createInteraction(id, body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateInteractionRoute, async (c) => {
    const { id, iid } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await kernel.services.customers.updateInteraction(id, iid, body, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteInteractionRoute, async (c) => {
    const { id, iid } = c.req.valid("param");
    const result = await kernel.services.customers.deleteInteraction(id, iid, c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: { deleted: true } });
  });

  return router;
}
