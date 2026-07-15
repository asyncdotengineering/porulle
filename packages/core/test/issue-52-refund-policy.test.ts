import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { markOrderPaidForTest } from "../src/test-utils/order-test-helpers.js";

// Issue #52 — core refund (#37) moves money and flips status, but retail
// policy lived in consumer metadata hacks: per-line refundedQuantity, a
// configurable daily refund cap per operator, and an undo window. These are
// now first-class: line-level refund REST that enforces refundable quantity,
// a policies.refundDailyCap checked at refund time (403 with the cap
// surfaced), and an audited undo that restores line quantities and cap room.
describe("Issue #52 — refund policy primitives", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;

    // Daily cap: 3000 minor units per operator (issue #49 settings)
    await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/policies",
      body: { refundDailyCap: 3000 },
      actor: testActor,
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `e52-${Date.now()}-${Math.round(performance.now() * 1000)}`, metadata: { title: "E" } },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function createOrder(): Promise<{ orderId: string; lineItemId: string }> {
    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "LKR",
        subtotal: 2000,
        taxTotal: 200,
        shippingTotal: 0,
        grandTotal: 2200,
        lineItems: [
          { entityId, entityType: "product", title: "Saree", quantity: 2, unitPrice: 1000, totalPrice: 2000, taxAmount: 200 },
        ],
      },
      actor: testActor,
    });
    const json = await parseJsonResponse<{ data: { id: string; lineItems: Array<{ id: string }> } }>(res);
    // Refunds require a paid order (R-03). Mark this order captured so the
    // refund-ledger/policy behavior under test can run.
    await markOrderPaidForTest(kernel, json.data.id, 2200);
    return { orderId: json.data.id, lineItemId: json.data.lineItems[0]!.id };
  }

  async function refund(orderId: string, lineItemId: string, quantity: number) {
    return makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/refunds`,
      body: { lines: [{ lineItemId, quantity }], reason: "customer returned item" },
      actor: testActor,
    });
  }

  it("tracks refundedQuantity per line and rejects over-refunding", async () => {
    const { orderId, lineItemId } = await createOrder();

    // Refund 1 of 2 → per-line amount is (2000 + 200 tax) / 2 = 1100
    const first = await refund(orderId, lineItemId, 1);
    expect(first.status).toBe(201);
    const firstBody = (await parseJsonResponse<{ data: any }>(first)).data;
    expect(firstBody.refund.amount).toBe(1100);
    const line = firstBody.order.lineItems.find((l: any) => l.id === lineItemId);
    expect(line.refundedQuantity).toBe(1);

    // Refunding 2 more exceeds the line's quantity → rejected
    const over = await refund(orderId, lineItemId, 2);
    expect(over.status).toBe(422);

    // Refunding the remaining 1 is fine
    const second = await refund(orderId, lineItemId, 1);
    expect(second.status).toBe(201);

    // Line is now fully refunded — any further refund is rejected
    const exhausted = await refund(orderId, lineItemId, 1);
    expect(exhausted.status).toBe(422);
  });

  it("enforces the daily refund cap per operator with the cap surfaced, and undo restores cap room", async () => {
    // The previous test consumed 2200 of the 3000 cap for testActor today.
    const { orderId, lineItemId } = await createOrder();

    const capped = await refund(orderId, lineItemId, 1); // 1100 more > 3000
    expect(capped.status).toBe(403);
    const err = await parseJsonResponse<{ error: { message: string } }>(capped);
    expect(err.error.message).toContain("3000");

    // Cap status endpoint shows usage
    const capRes = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/orders/refunds/cap",
      actor: testActor,
    });
    expect(capRes.status).toBe(200);
    const cap = (await parseJsonResponse<{ data: any }>(capRes)).data;
    expect(cap.cap).toBe(3000);
    expect(cap.usedToday).toBe(2200);
    expect(cap.remaining).toBe(800);
  });

  it("undoes a refund within the window, restoring line quantity and auditing both directions", async () => {
    // Fresh server state is shared; raise the cap out of the way.
    await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/policies",
      body: { refundDailyCap: 1_000_000 },
      actor: testActor,
    });

    const { orderId, lineItemId } = await createOrder();
    const res = await refund(orderId, lineItemId, 2);
    expect(res.status).toBe(201);
    const refundId = (await parseJsonResponse<{ data: any }>(res)).data.refund.id;

    // Undo within the window
    const undo = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/refunds/${refundId}/undo`,
      actor: testActor,
    });
    expect(undo.status).toBe(200);
    const undone = (await parseJsonResponse<{ data: any }>(undo)).data;
    expect(undone.refund.status).toBe("undone");
    const line = undone.order.lineItems.find((l: any) => l.id === lineItemId);
    expect(line.refundedQuantity).toBe(0);

    // A second undo of the same refund is rejected
    const again = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/refunds/${refundId}/undo`,
      actor: testActor,
    });
    expect(again.status).toBe(422);

    // The refund list shows the full audit trail
    const listRes = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderId}/refunds`,
      actor: testActor,
    });
    const rows = (await parseJsonResponse<{ data: any[] }>(listRes)).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("undone");
    expect(rows[0].undoneBy).toBeTruthy();
  });
});
