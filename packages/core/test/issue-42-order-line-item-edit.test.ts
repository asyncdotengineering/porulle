import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #42 — a placed order's line items couldn't be edited over REST.
// POST/PATCH/DELETE /api/orders/{id}/line-items(/{lineItemId}) now support
// add / adjust-quantity / remove with totals recalculated, guarded against
// terminal orders.
describe("Issue #42 — order line-item editing with totals recalc", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `e42-${Date.now()}-${Math.round(performance.now() * 1000)}`, metadata: { title: "E" } },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function createOrder(): Promise<{ orderId: string; lineItemId: string; entityId: string }> {
    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "USD",
        subtotal: 2000,
        taxTotal: 200,
        shippingTotal: 500,
        grandTotal: 2700,
        lineItems: [
          { entityId, entityType: "product", title: "Tea", quantity: 2, unitPrice: 1000, totalPrice: 2000, taxAmount: 200 },
        ],
      },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const json = await parseJsonResponse<{ data: { id: string; lineItems: Array<{ id: string }> } }>(res);
    return { orderId: json.data.id, lineItemId: json.data.lineItems[0]!.id, entityId };
  }

  it("adds a line item and recalculates totals", async () => {
    const { orderId } = await createOrder();
    const newEntity = await createEntity();

    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/line-items`,
      body: { entityId: newEntity, entityType: "product", title: "Mug", quantity: 1, unitPrice: 1500, taxAmount: 150 },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const order = (await parseJsonResponse<{ data: any }>(res)).data;
    expect(order.lineItems).toHaveLength(2);
    expect(order.subtotal).toBe(2000 + 1500);
    expect(order.taxTotal).toBe(200 + 150);
    // shipping unchanged, no discounts
    expect(order.grandTotal).toBe(3500 + 350 + 500);
  });

  it("adjusts a line item's quantity, scaling line totals and tax", async () => {
    const { orderId, lineItemId } = await createOrder();

    const res = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/orders/${orderId}/line-items/${lineItemId}`,
      body: { quantity: 3 },
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const order = (await parseJsonResponse<{ data: any }>(res)).data;
    const line = order.lineItems.find((li: any) => li.id === lineItemId);
    expect(line.quantity).toBe(3);
    expect(line.totalPrice).toBe(3000);
    expect(line.taxAmount).toBe(300); // scaled from 200 @ qty 2 → per-unit 100
    expect(order.subtotal).toBe(3000);
    expect(order.taxTotal).toBe(300);
    expect(order.grandTotal).toBe(3000 + 300 + 500);
  });

  it("removes a line item and refuses to remove the last one", async () => {
    const { orderId, lineItemId } = await createOrder();
    const newEntity = await createEntity();

    const add = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/line-items`,
      body: { entityId: newEntity, entityType: "product", title: "Mug", quantity: 1, unitPrice: 1500 },
      actor: testActor,
    });
    expect(add.status).toBe(201);

    const del = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/orders/${orderId}/line-items/${lineItemId}`,
      actor: testActor,
    });
    expect(del.status).toBe(200);
    const order = (await parseJsonResponse<{ data: any }>(del)).data;
    expect(order.lineItems).toHaveLength(1);
    expect(order.subtotal).toBe(1500);
    expect(order.taxTotal).toBe(0);
    expect(order.grandTotal).toBe(1500 + 500);

    const remaining = order.lineItems[0].id;
    const lastDel = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/orders/${orderId}/line-items/${remaining}`,
      actor: testActor,
    });
    expect(lastDel.status).toBe(422);
  });

  it("guards terminal orders from edits", async () => {
    const { orderId, lineItemId } = await createOrder();

    const cancel = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/orders/${orderId}/status`,
      body: { status: "cancelled" },
      actor: testActor,
    });
    expect(cancel.status).toBe(200);

    const res = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/orders/${orderId}/line-items/${lineItemId}`,
      body: { quantity: 5 },
      actor: testActor,
    });
    expect(res.status).toBe(422);
  });

  it("records an audit entry in the order's status history", async () => {
    const { orderId } = await createOrder();
    const newEntity = await createEntity();

    await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/line-items`,
      body: { entityId: newEntity, entityType: "product", title: "Mug", quantity: 1, unitPrice: 1500 },
      actor: testActor,
    });

    const history = await kernel.services.orders.getStatusHistory(orderId, testActor);
    expect(history.ok).toBe(true);
    expect(history.value.some((h: any) => /line_item/.test(h.reason ?? ""))).toBe(true);
  });
});
