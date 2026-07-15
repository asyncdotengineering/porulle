import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { organization } from "../src/auth/auth-schema.js";
import type { Actor } from "../src/auth/types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import type { Kernel } from "../src/runtime/kernel.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

const FOREIGN_ORG_ID = "org_order_hardening_foreign";

const customerActor: Actor = {
  type: "user",
  userId: "order-hardening-customer",
  email: "customer@order-hardening.test",
  name: "Order Hardening Customer",
  vendorId: null,
  organizationId: "org_default",
  role: "customer",
  permissions: [
    "catalog:read",
    "cart:create",
    "cart:read",
    "cart:update",
    "orders:create",
    "orders:read:own",
  ],
};

const foreignStaffActor: Actor = {
  ...testActor,
  userId: "order-hardening-foreign-staff",
  email: "staff@foreign-order-hardening.test",
  organizationId: FOREIGN_ORG_ID,
};

describe("order creation hardening", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Kernel;
  let cleanup: () => Promise<void>;
  let entityId: string;
  let foreignEntityId: string;
  let foreignVariantId: string;

  beforeAll(async () => {
    const testServer = await createTestServer();
    server = testServer.server;
    kernel = testServer.kernel;
    cleanup = testServer.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const db = kernel.database.db as DrizzleDatabase;
    await db.insert(organization).values({
      id: FOREIGN_ORG_ID,
      name: "Order Hardening Foreign Org",
      slug: "order-hardening-foreign",
      createdAt: new Date(),
    });

    const localEntity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `order-hardening-local-${crypto.randomUUID()}`,
        attributes: { title: "Server-priced product" },
        metadata: {},
      },
      testActor,
    );
    expect(localEntity.ok).toBe(true);
    if (!localEntity.ok) throw localEntity.error;
    entityId = localEntity.value.id;

    const price = await kernel.services.pricing.setBasePrice({
      entityId,
      currency: "USD",
      amount: 7500,
    });
    expect(price.ok).toBe(true);

    const warehouse = await kernel.services.inventory.createWarehouse(
      { name: "Order Hardening Warehouse", code: `OH-${crypto.randomUUID()}` },
      testActor,
    );
    expect(warehouse.ok).toBe(true);
    const stock = await kernel.services.inventory.adjust(
      {
        entityId,
        adjustment: 20,
        reason: "order hardening checkout stock",
      },
      testActor,
    );
    expect(stock.ok).toBe(true);

    const foreignEntity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `order-hardening-foreign-${crypto.randomUUID()}`,
        attributes: { title: "Foreign product" },
        metadata: {},
      },
      foreignStaffActor,
    );
    expect(foreignEntity.ok).toBe(true);
    if (!foreignEntity.ok) throw foreignEntity.error;
    foreignEntityId = foreignEntity.value.id;

    const foreignVariant = await kernel.services.catalog.createVariant(
      {
        entityId: foreignEntityId,
        options: {},
        sku: `FOREIGN-${crypto.randomUUID()}`,
      },
      foreignStaffActor,
    );
    expect(foreignVariant.ok).toBe(true);
    if (!foreignVariant.ok) throw foreignVariant.error;
    foreignVariantId = foreignVariant.value.id;
  });

  function orderBody(
    selectedEntityId: string,
    unitPrice: number,
    quantity = 1,
    variantId?: string,
  ) {
    return {
      currency: "USD",
      subtotal: unitPrice * quantity,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      grandTotal: unitPrice * quantity,
      lineItems: [
        {
          entityId: selectedEntityId,
          entityType: "product",
          ...(variantId ? { variantId } : {}),
          title: "Order hardening line",
          quantity,
          unitPrice,
          totalPrice: unitPrice * quantity,
        },
      ],
    };
  }

  async function createManualOrder() {
    const response = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(entityId, 1000),
      actor: testActor,
    });
    expect(response.status).toBe(201);
    return (await parseJsonResponse<{ data: { id: string } }>(response)).data;
  }

  it("gates the REST route and server-prices a direct orders:create caller", async () => {
    const routeResponse = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(entityId, 1),
      actor: customerActor,
    });
    expect(routeResponse.status).toBe(403);
    expect(
      (await parseJsonResponse<{ error: { code: string } }>(routeResponse)).error.code,
    ).toBe("FORBIDDEN");

    const directResult = await kernel.services.orders.create(
      orderBody(entityId, 1),
      customerActor,
    );
    expect(directResult.ok).toBe(true);
    if (!directResult.ok) throw directResult.error;
    expect(directResult.value.subtotal).toBe(7500);
    expect(directResult.value.grandTotal).toBe(7500);
    expect(directResult.value.lineItems[0]?.unitPrice).toBe(7500);
    expect(directResult.value.lineItems[0]?.isCustomPrice).toBe(false);
  });

  it("rejects cross-org entities and mismatched variants on create and addLineItem", async () => {
    const createResponse = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(foreignEntityId, 100),
      actor: testActor,
    });
    expect(createResponse.status).toBe(422);

    const order = await createManualOrder();
    const addForeignEntity = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${order.id}/line-items`,
      body: orderBody(foreignEntityId, 100).lineItems[0],
      actor: testActor,
    });
    expect(addForeignEntity.status).toBe(422);

    const addForeignVariant = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${order.id}/line-items`,
      body: orderBody(entityId, 100, 1, foreignVariantId).lineItems[0],
      actor: testActor,
    });
    expect(addForeignVariant.status).toBe(422);
  });

  it("stores an orders:manage price as an audited manual override", async () => {
    const response = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(entityId, 1234, 2),
      actor: testActor,
    });
    expect(response.status).toBe(201);
    const order = (
      await parseJsonResponse<{
        data: {
          subtotal: number;
          grandTotal: number;
          lineItems: Array<{
            unitPrice: number;
            totalPrice: number;
            isCustomPrice: boolean;
          }>;
        };
      }>(response)
    ).data;
    expect(order.subtotal).toBe(2468);
    expect(order.grandTotal).toBe(2468);
    expect(order.lineItems[0]).toMatchObject({
      unitPrice: 1234,
      totalPrice: 2468,
      isCustomPrice: true,
    });
  });

  it("keeps checkout server-priced for a customer actor", async () => {
    const cartResponse = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/carts",
      body: { currency: "USD" },
      actor: customerActor,
    });
    expect(cartResponse.status).toBe(201);
    const cart = (await parseJsonResponse<{ data: { id: string } }>(cartResponse)).data;

    const addResponse = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/carts/${cart.id}/items`,
      body: { entityId, quantity: 1 },
      actor: customerActor,
    });
    expect(addResponse.status).toBe(201);

    const checkoutResponse = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: {
        cartId: cart.id,
        paymentMethodId: "test-payments",
        currency: "USD",
      },
      actor: customerActor,
    });
    expect(checkoutResponse.status).toBe(201);
    const order = (
      await parseJsonResponse<{
        data: {
          subtotal: number;
          lineItems: Array<{ unitPrice: number; isCustomPrice: boolean }>;
        };
        meta?: { hookErrors?: unknown[] };
      }>(checkoutResponse)
    );
    expect(order.meta?.hookErrors).toBeUndefined();
    expect(order.data.subtotal).toBe(7500);
    expect(order.data.lineItems[0]).toMatchObject({
      unitPrice: 7500,
      isCustomPrice: false,
    });

    const available = await kernel.services.inventory.getAvailable(
      entityId,
      undefined,
      undefined,
      customerActor,
    );
    expect(available.ok).toBe(true);
    if (!available.ok) throw available.error;
    expect(available.value).toBe(19);
  });
});
