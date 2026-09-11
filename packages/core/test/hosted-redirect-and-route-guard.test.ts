/**
 * The three core changes the marketplace needs, as three independent failures.
 *
 * Written before the implementation and NOT editable by the work that implements it: these are the
 * contract. Each `describe` fails on its own, so a partial implementation is visible as a partial
 * pass rather than as one red blob.
 *
 * 1. Hosted-redirect payments. `PaymentAdapter.createPaymentIntent` assumes an intent plus a client
 *    secret, which is Stripe Elements' shape. PayHere, WebXPay and Genie are redirect gateways: the
 *    shopper is sent to the provider's page and comes back. A redirect adapter therefore has nowhere
 *    to put its URL and the checkout route has nothing to return, so the mobile app cannot open the
 *    gateway at all.
 * 2. The route permission guard is not exported, so a raw `config.routes` webhook endpoint has to
 *    reach for `Object.getOwnPropertySymbols(requirePerm(...))` to satisfy `assertRouteCoverage`.
 *    `apps/merchant-center-api` does exactly that, eleven times.
 * 3. `.permission()` on a RouteChain is stricter than `hasPermission` is everywhere else: it accepts
 *    the exact scope or `*:*` and rejects `resource:*`. The same actor passes one check and fails the
 *    other, which makes a role's meaning depend on which layer happens to read it.
 *
 * The design's fourth, optional item — free-form metadata on `EnqueueOptions` — is deliberately not
 * here: persisting it needs a new column on `commerce_jobs` in a published package, and nothing
 * consumes it until the vendor plugins exist. A type-only field no engine stores is worse than its
 * absence, because it reads as a working feature. See the decision on the task.
 */

import { describe, it, expect } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { Ok } from "../src/kernel/result.js";
import { router } from "../src/index.js";
import * as coreExports from "../src/index.js";
import { findUncoveredRoutes } from "../src/interfaces/rest/route-coverage.js";
import type { Actor } from "../src/auth/types.js";
import type { PluginRouteRegistration } from "../src/kernel/plugin/manifest.js";

// ─── 1. Hosted-redirect payments ──────────────────────────────────────────────

const GATEWAY_PAGE = "https://sandbox.payhere.lk/pay/o1234567890";

/**
 * A gateway that has no client secret to give and a page to send the shopper to. Deliberately
 * records what it was handed, because "the redirect came back" and "the return URL got there" are
 * two different claims and only the second one makes a real gateway able to return the shopper.
 */
function createRedirectAdapter() {
  const seen: { returnUrl?: string; cancelUrl?: string }[] = [];
  return {
    seen,
    adapter: {
      providerId: "redirect-gateway",
      async createPaymentIntent(params: { returnUrl?: string; cancelUrl?: string; amount: number; currency: string }) {
        seen.push({ returnUrl: params.returnUrl, cancelUrl: params.cancelUrl });
        return Ok({
          id: "pi_redirect_1",
          status: "requires_action",
          amount: params.amount,
          currency: params.currency,
          redirectUrl: GATEWAY_PAGE,
        });
      },
      async capturePayment() {
        return Ok({ id: "pi_redirect_1", status: "succeeded", amountCaptured: 0 });
      },
      async refundPayment() {
        return Ok({ id: "re_redirect_1", status: "succeeded", amountRefunded: 0 });
      },
      async cancelPaymentIntent() {
        return Ok(undefined);
      },
      async verifyWebhook() {
        return Ok({ id: "evt_1", type: "payment.succeeded", data: {} });
      },
    },
  };
}

/**
 * A cart that can actually be checked out: a base price on the entity and stock in a warehouse.
 * Both are required — without the price the pipeline fails at `resolveCurrentPrices`, without the
 * stock at `checkInventoryAvailability`, and either one returns the same 422 the existing
 * `api-checkout` tests accept as a pass.
 */
async function seedPayableCart(harness: Awaited<ReturnType<typeof createTestServer>>): Promise<string> {
  const { server, kernel } = harness;
  const entityResponse = await makeRequest(server, {
    method: "POST",
    url: "http://localhost/api/catalog/entities",
    body: {
      type: "product",
      slug: `redirect-${Date.now()}-${Math.round(performance.now() * 1000)}`,
      metadata: { title: "Redirect Product", basePrice: 5000 },
    },
    actor: testActor,
  });
  const entity = await parseJsonResponse<{ data: { id: string } }>(entityResponse);
  await kernel.services.inventory.adjust(
    { entityId: entity.data.id, adjustment: 10, reason: "stock" },
    testActor,
  );

  const cartResponse = await makeRequest(server, {
    method: "POST",
    url: "http://localhost/api/carts",
    body: { currency: "USD" },
  });
  const cart = await parseJsonResponse<{ data: { id: string } }>(cartResponse);
  await makeRequest(server, {
    method: "POST",
    url: `http://localhost/api/carts/${cart.data.id}/items`,
    body: { entityId: entity.data.id, quantity: 1 },
  });
  return cart.data.id;
}

const SHIPPING_ADDRESS = { line1: "1 Galle Road", city: "Colombo", postalCode: "00300", country: "LK" };

describe("hosted-redirect payments", () => {
  it("returns the gateway page to the shopper and hands the adapter its return URL", async () => {
    const { adapter, seen } = createRedirectAdapter();
    const isolated = await createTestServer({ payments: [adapter] });
    try {
      await isolated.kernel.services.inventory.createWarehouse({ name: "Main", code: `MAIN-${Date.now()}` }, testActor);
      const cartId = await seedPayableCart(isolated);

      const response = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/checkout",
        body: {
          cartId,
          paymentMethodId: "redirect-gateway",
          currency: "USD",
          returnUrl: "https://minimaldraft.lk/checkout/return",
          cancelUrl: "https://minimaldraft.lk/checkout/cancel",
          shippingAddress: SHIPPING_ADDRESS,
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);
      const body = await parseJsonResponse<{ data: { paymentRedirectUrl?: string } }>(response);
      // Without this the mobile app has an order it cannot pay for.
      expect(body.data.paymentRedirectUrl).toBe(GATEWAY_PAGE);
      // And without this the gateway has nowhere to send the shopper back to.
      expect(seen[0]?.returnUrl).toBe("https://minimaldraft.lk/checkout/return");
      expect(seen[0]?.cancelUrl).toBe("https://minimaldraft.lk/checkout/cancel");
    } finally {
      await isolated.cleanup();
    }
  });

  it("leaves a client-secret gateway exactly as it was", async () => {
    // The control. This one passes TODAY and must keep passing: Stripe must not acquire a redirect.
    const isolated = await createTestServer();
    try {
      await isolated.kernel.services.inventory.createWarehouse({ name: "Main", code: `MAIN-${Date.now()}` }, testActor);
      const cartId = await seedPayableCart(isolated);

      const response = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/checkout",
        body: {
          cartId,
          paymentMethodId: "test-payments",
          currency: "USD",
          shippingAddress: SHIPPING_ADDRESS,
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);
      const body = await parseJsonResponse<{ data: { paymentRedirectUrl?: string } }>(response);
      expect(body.data.paymentRedirectUrl).toBeUndefined();
    } finally {
      await isolated.cleanup();
    }
  });
});

// ─── 2. The route permission guard is exported ────────────────────────────────

describe("route permission guard export", () => {
  it("exports markRoutePermissionGuard and markPublicRoute from the package entry point", () => {
    // The symbol hack exists because these two are reachable only from a deep path today.
    expect(typeof (coreExports as Record<string, unknown>).markRoutePermissionGuard).toBe("function");
    expect(typeof (coreExports as Record<string, unknown>).markPublicRoute).toBe("function");
  });

  it("satisfies assertRouteCoverage for a raw route marked with the exported helper", () => {
    const markPublicRoute = (coreExports as unknown as {
      markPublicRoute?: <T>(handler: T, methods?: readonly string[]) => T;
    }).markPublicRoute;
    expect(markPublicRoute).toBeTypeOf("function");

    const app = new OpenAPIHono();
    app.use("/api/vendor-webhook", markPublicRoute!(async (_c: unknown, next: () => Promise<void>) => {
      await next();
    }));
    app.post("/api/vendor-webhook", (c) => c.json({ ok: true }));

    // The route is not in PUBLIC_ROUTES, so only the marker can clear it.
    expect(findUncoveredRoutes(app as unknown as { routes: readonly never[] })).toEqual([]);
  });
});

// ─── 3. Wildcard parity between .permission() and hasPermission ───────────────

function actorWith(permissions: string[]): Actor {
  return { ...testActor, permissions } as Actor;
}

async function callGuardedRoute(actor: Actor): Promise<number> {
  const r = router("Widgets", "/widgets");
  r.get("/").summary("List").permission("widgets:read").handler(async () => ({ ok: true }));
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("actor", actor as never);
    await next();
  });
  for (const route of r.routes()) {
    if (!("openapi" in route)) continue;
    const openapiRoute = route as Extract<PluginRouteRegistration, { openapi: unknown }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.openapi(openapiRoute.openapi as any, openapiRoute.handler as any);
  }
  const response = await app.request("/api/widgets");
  return response.status;
}

describe("RouteChain permission wildcards", () => {
  it("accepts resource:* the way hasPermission does", async () => {
    // A merchant role is granted vendor:* — it must not fail a vendor:read route.
    expect(await callGuardedRoute(actorWith(["widgets:*"]))).toBe(200);
  });

  it("still accepts the exact scope and *:*, and still rejects an unrelated one", async () => {
    expect(await callGuardedRoute(actorWith(["widgets:read"]))).toBe(200);
    expect(await callGuardedRoute(actorWith(["*:*"]))).toBe(200);
    expect(await callGuardedRoute(actorWith(["orders:*"]))).toBe(403);
    expect(await callGuardedRoute(actorWith([]))).toBe(403);
  });
});
