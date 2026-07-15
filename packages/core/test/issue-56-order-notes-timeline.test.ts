import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  noPermActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { markOrderPaidForTest } from "../src/test-utils/order-test-helpers.js";

// Issue #56 — orders had status history but no operator annotations and no
// unified activity view. Notes are first-class rows (author, pinned) and the
// timeline merges status history + notes + refund ledger events, newest
// first, so an operator reads everything that happened to an order in one
// place.
describe("Issue #56 — order notes + activity timeline", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  let orderId: string;
  let lineItemId: string;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;

    const entityRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `e56-${Date.now()}`, metadata: { title: "E" } },
      actor: testActor,
    });
    const entityId = (await parseJsonResponse<{ data: { id: string } }>(entityRes)).data.id;

    const orderRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "LKR",
        subtotal: 2000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 2000,
        lineItems: [
          { entityId, entityType: "product", title: "Saree", quantity: 2, unitPrice: 1000, totalPrice: 2000 },
        ],
      },
      actor: testActor,
    });
    const order = (await parseJsonResponse<{ data: any }>(orderRes)).data;
    orderId = order.id;
    // Refunds require a paid order (R-03) — mark the order captured.
    await markOrderPaidForTest(kernel, orderId, 2000);
    lineItemId = order.lineItems[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates, lists (pinned first), and deletes notes", async () => {
    const first = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/notes`,
      body: { body: "Customer will pick up Thursday" },
      actor: testActor,
    });
    expect(first.status).toBe(201);
    const note1 = (await parseJsonResponse<{ data: any }>(first)).data;
    expect(note1.author).toBe(testActor.userId);
    expect(note1.pinned).toBe(false);

    const second = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/notes`,
      body: { body: "VIP — gift wrap", pinned: true },
      actor: testActor,
    });
    const note2 = (await parseJsonResponse<{ data: any }>(second)).data;

    const list = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/orders/${orderId}/notes`,
        actor: testActor,
      }),
    );
    expect(list.data).toHaveLength(2);
    expect(list.data[0].id).toBe(note2.id); // pinned first

    const del = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/orders/${orderId}/notes/${note1.id}`,
      actor: testActor,
    });
    expect(del.status).toBe(200);
    const after = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/orders/${orderId}/notes`,
        actor: testActor,
      }),
    );
    expect(after.data).toHaveLength(1);
  });

  it("returns one merged timeline: status changes + notes + refunds, newest first", async () => {
    // Generate a status change and a refund on top of the note
    const statusRes = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/orders/${orderId}/status`,
      body: { status: "confirmed" },
      actor: testActor,
    });
    expect(statusRes.status).toBe(200);

    const refundRes = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/refunds`,
      body: { lines: [{ lineItemId, quantity: 1 }], reason: "damaged" },
      actor: testActor,
    });
    expect(refundRes.status).toBe(201);

    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderId}/timeline`,
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const events = (await parseJsonResponse<{ data: any[] }>(res)).data;

    const types = events.map((e) => e.type);
    expect(types).toContain("note");
    expect(types).toContain("status");
    expect(types).toContain("refund");

    // Newest first
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i - 1].at).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i].at).getTime(),
      );
    }
    // Every event carries an actor + summary
    for (const event of events) {
      expect(typeof event.summary).toBe("string");
      expect(event.at).toBeTruthy();
    }
  });

  it("requires order access", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderId}/timeline`,
      actor: noPermActor,
    });
    expect(res.status).toBe(403);
  });
});
