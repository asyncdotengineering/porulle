import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #40 — fulfillment was read-only over REST: an admin could flip an
// order to `fulfilled` but couldn't record a tracking number/carrier or ship
// a subset of the line items. POST /api/orders/{id}/fulfillments now creates
// a fulfillment for specific line-item quantities with tracking details.
describe("Issue #40 — POST /api/orders/{id}/fulfillments", () => {
  let server: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `f40-${Date.now()}-${Math.round(performance.now() * 1000)}`, metadata: { title: "F" } },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function createOrder(quantity: number): Promise<{ orderId: string; lineItemId: string }> {
    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "USD",
        subtotal: 1000 * quantity,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 1000 * quantity,
        lineItems: [
          { entityId, entityType: "product", title: "Ceylon Black Tea", quantity, unitPrice: 1000, totalPrice: 1000 * quantity },
        ],
      },
      actor: testActor,
    });
    const json = await parseJsonResponse<{ data: { id: string; lineItems: Array<{ id: string }> } }>(res);
    expect(res.status).toBe(201);
    return { orderId: json.data.id, lineItemId: json.data.lineItems[0]!.id };
  }

  it("records a shipment with tracking details and returns it on the order's fulfillments", async () => {
    const { orderId, lineItemId } = await createOrder(2);

    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/fulfillments`,
      body: {
        lineItems: [{ orderLineItemId: lineItemId, quantity: 2 }],
        carrier: "DHL",
        trackingNumber: "DHL-123456",
        trackingUrl: "https://track.dhl.com/DHL-123456",
      },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const created = await parseJsonResponse<{ data: any }>(res);
    expect(created.data.trackingNumber).toBe("DHL-123456");
    expect(created.data.carrier).toBe("DHL");
    expect(created.data.status).toBe("shipped");
    expect(created.data.lineItems).toHaveLength(1);
    expect(created.data.lineItems[0].quantity).toBe(2);

    const get = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderId}/fulfillments`,
      actor: testActor,
    });
    expect(get.status).toBe(200);
    const listed = await parseJsonResponse<{ data: any[] }>(get);
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].trackingNumber).toBe("DHL-123456");
    expect(listed.data[0].carrier).toBe("DHL");
  });

  it("supports partial fulfillment and reflects per-line fulfillment status", async () => {
    const { orderId, lineItemId } = await createOrder(3);

    const partial = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/fulfillments`,
      body: { lineItems: [{ orderLineItemId: lineItemId, quantity: 2 }], trackingNumber: "T-1" },
      actor: testActor,
    });
    expect(partial.status).toBe(201);

    let order = await parseJsonResponse<{ data: { lineItems: Array<{ fulfillmentStatus: string }> } }>(
      await makeRequest(server, { method: "GET", url: `http://localhost/api/orders/${orderId}`, actor: testActor }),
    );
    expect(order.data.lineItems[0]!.fulfillmentStatus).toBe("partial");

    const rest = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/fulfillments`,
      body: { lineItems: [{ orderLineItemId: lineItemId, quantity: 1 }], trackingNumber: "T-2" },
      actor: testActor,
    });
    expect(rest.status).toBe(201);

    order = await parseJsonResponse<{ data: { lineItems: Array<{ fulfillmentStatus: string }> } }>(
      await makeRequest(server, { method: "GET", url: `http://localhost/api/orders/${orderId}`, actor: testActor }),
    );
    expect(order.data.lineItems[0]!.fulfillmentStatus).toBe("fulfilled");

    // Two separate fulfillments now exist on the order
    const listed = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: `http://localhost/api/orders/${orderId}/fulfillments`, actor: testActor }),
    );
    expect(listed.data).toHaveLength(2);
  });

  it("rejects over-fulfillment beyond the ordered quantity", async () => {
    const { orderId, lineItemId } = await createOrder(2);

    const over = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/fulfillments`,
      body: { lineItems: [{ orderLineItemId: lineItemId, quantity: 3 }] },
      actor: testActor,
    });
    expect(over.status).toBe(422);
  });

  it("rejects a line item that does not belong to the order", async () => {
    const { orderId } = await createOrder(1);
    const other = await createOrder(1);

    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/fulfillments`,
      body: { lineItems: [{ orderLineItemId: other.lineItemId, quantity: 1 }] },
      actor: testActor,
    });
    expect(res.status).toBe(422);
  });
});
