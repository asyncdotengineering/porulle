import { describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { orders } from "../src/modules/orders/schema.js";
import { createCustomerPortalRoutes } from "../src/interfaces/rest/customer-portal.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { createKernel } from "../src/runtime/kernel.js";
import { Hono } from "hono";
import type { AppEnv } from "../src/interfaces/rest/utils.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

const STORE = "org_round2_identity";

const customerActor: Actor = {
  type: "user",
  userId: "round2-portal-customer",
  email: "round2-portal@example.com",
  name: "Round 2 Customer",
  vendorId: null,
  organizationId: "org_round2_portal",
  role: "customer",
  permissions: ["orders:read:own", "customers:read:self"],
};

describe("round 2 identity and caller regressions", () => {
  it("does not mint a customer identity for a store-resolved anonymous actor", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      auth: {
        storeResolver: () => STORE,
      },
    });
    try {
      const kernel = createKernel(config);
      const auth = (await import("../src/auth/setup.js")).createAuth(kernel.database, config);
      const app = new Hono<{ Variables: { actor: Actor | null } }>();
      app.use("*", (await import("../src/auth/middleware.js")).authMiddleware(auth, config));
      app.get("/probe", (c) => c.json(c.get("actor")));

      const response = await app.request("http://localhost/probe");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        organizationId: STORE,
        userId: null,
      });
    } finally {
      await cleanup();
    }
  });

  it("issues and enforces a secret for a public guest cart", async () => {
    const { server, kernel, cleanup } = await createTestServer({
      auth: {
        storeResolver: (request) => request.headers.get("x-store-id"),
      },
    });
    try {
      await kernel.services.organization.create({ id: STORE, name: "Round 2 Store", slug: "round2-store" });
      const product = await kernel.services.catalog.create(
        { type: "product", slug: "round2-cart-product", status: "active" },
        { ...testActor, organizationId: STORE },
      );
      expect(product.ok).toBe(true);
      if (!product.ok) throw product.error;

      const createResponse = await server.fetch(new Request("http://localhost/api/carts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-store-id": STORE },
        body: JSON.stringify({ currency: "USD" }),
      }));
      expect(createResponse.status).toBe(201);
      const created = await parseJsonResponse<{ data: { id: string; secret: string | null; customerId: string | null } }>(createResponse);
      expect(created.data.customerId).toBeNull();
      expect(created.data.secret).toEqual(expect.any(String));

      const noSecretRead = await server.fetch(new Request(`http://localhost/api/carts/${created.data.id}`, {
        headers: { "x-store-id": STORE },
      }));
      expect(noSecretRead.status).toBe(403);

      const validRead = await server.fetch(new Request(`http://localhost/api/carts/${created.data.id}`, {
        headers: { "x-store-id": STORE, "x-cart-secret": created.data.secret! },
      }));
      expect(validRead.status).toBe(200);

      const noSecretWrite = await server.fetch(new Request(`http://localhost/api/carts/${created.data.id}/items`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-store-id": STORE },
        body: JSON.stringify({ entityId: product.value.id, quantity: 1 }),
      }));
      expect(noSecretWrite.status).toBe(403);

      const validWrite = await server.fetch(new Request(`http://localhost/api/carts/${created.data.id}/items`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-store-id": STORE,
          "x-cart-secret": created.data.secret!,
        },
        body: JSON.stringify({ entityId: product.value.id, quantity: 1 }),
      }));
      expect(validWrite.status).toBe(201);
    } finally {
      await cleanup();
    }
  });

  it("lists a customer's orders in the actor's organization", async () => {
    const { config, cleanup } = await createPGliteTestConfig();
    try {
      const kernel = createKernel(config);
      await kernel.services.organization.create({ id: "org_round2_portal", name: "Portal Store", slug: "round2-portal" });
      const userId = customerActor.userId;
      if (!userId) throw new Error("Test customer must have a user id.");
      const customer = await kernel.services.customers.getByUserId(userId, customerActor);
      expect(customer.ok).toBe(true);
      if (!customer.ok) throw customer.error;

      const db = kernel.database.db as { insert: (table: typeof orders) => { values: (value: unknown) => Promise<unknown> } };
      await db.insert(orders).values({
        organizationId: customerActor.organizationId,
        orderNumber: "ORD-ROUND2-000001",
        customerId: customer.value.id,
        status: "pending",
        currency: "USD",
        subtotal: 1000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 1000,
        metadata: {},
      });

      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", customerActor);
        await next();
      });
      app.route("/api/me", createCustomerPortalRoutes(kernel));

      const response = await app.request("http://localhost/api/me/orders");
      expect(response.status).toBe(200);
      const body = await parseJsonResponse<{ data: Array<{ orderNumber: string }> }>(response);
      expect(body.data.map((order) => order.orderNumber)).toContain("ORD-ROUND2-000001");
    } finally {
      await cleanup();
    }
  });

  it("keeps headerless allowlisted reads as not-found responses", async () => {
    const { server, cleanup } = await createTestServer({
      auth: {
        storeResolver: (request) => request.headers.get("x-store-id"),
        defaultOrganizationId: "",
      },
    });
    try {
      const mediaResponse = await server.fetch(new Request(
        "http://localhost/api/media/00000000-0000-4000-8000-000000000000",
      ));
      const cartResponse = await server.fetch(new Request(
        "http://localhost/api/carts/00000000-0000-4000-8000-000000000001",
      ));
      expect(mediaResponse.status).toBe(404);
      expect(cartResponse.status).toBe(404);
    } finally {
      await cleanup();
    }
  });
});
