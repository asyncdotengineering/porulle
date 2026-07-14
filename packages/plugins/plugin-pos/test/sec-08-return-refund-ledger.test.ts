import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, posAdminActor } from "./test-utils.js";
import { posPlugin } from "../src/index.js";

const UNIT_PRICE = 3000;

/**
 * SEC-08 — POS returns must derive the refund from the original order, not the
 * client. Routing through orders.refundLines validates order/line ownership,
 * caps by the refundable quantity ledger (blocking over- and double-refunds),
 * and computes the amount server-side. A cashier can no longer fabricate an
 * unbounded cash refund against a foreign/fake order.
 */
describe("SEC-08 — POS return refund is server-derived, capped, idempotent", () => {
  let app: PluginTestApp["app"];
  let kernel: PluginTestApp["kernel"];
  let terminalId: string;
  let shiftId: string;
  let entityId: string;

  const actor: Actor = {
    ...posAdminActor,
    permissions: [
      ...posAdminActor.permissions,
      "orders:create", "orders:read", "orders:update", "catalog:create", "pricing:manage",
    ],
  };

  async function makeOrder() {
    const order = await (kernel.services as any).orders.create(
      {
        currency: "USD", subtotal: UNIT_PRICE, taxTotal: 0, shippingTotal: 0, grandTotal: UNIT_PRICE,
        lineItems: [{
          entityId, entityType: "product", title: "Saree",
          quantity: 1, unitPrice: UNIT_PRICE, totalPrice: UNIT_PRICE, taxAmount: 0,
        }],
      },
      actor,
    );
    expect(order.ok).toBe(true);
    return { orderId: order.value.id, lineItemId: order.value.lineItems[0].id };
  }
  const returnReq = (body: unknown) =>
    app.request("http://localhost/api/pos/returns", {
      method: "POST", headers: jsonHeaders(actor), body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const built = await createPluginTestApp(posPlugin());
    app = built.app;
    kernel = built.kernel;
    const entity = await (kernel.services as any).catalog.create(
      { type: "product", slug: `sec08-${Date.now()}`, metadata: { title: "Saree" } }, actor,
    );
    entityId = entity.value.id;
    await (kernel.services as any).pricing.setBasePrice({ entityId, currency: "USD", amount: UNIT_PRICE }, actor);
    const t = await app.request("http://localhost/api/pos/terminals", {
      method: "POST", headers: jsonHeaders(posAdminActor), body: JSON.stringify({ name: "SEC-08", code: "SEC08" }),
    });
    terminalId = (await t.json()).data.id;
    const s = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST", headers: jsonHeaders(actor), body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    shiftId = (await s.json()).data.id;
  }, 30_000);

  it("computes the refund from the order, ignoring any client amount", async () => {
    const { orderId, lineItemId } = await makeOrder();
    const res = await returnReq({
      shiftId, terminalId, originalOrderId: orderId,
      // note: refundAmount is intentionally NOT sent — server derives it
      items: [{ originalLineItemId: lineItemId, quantity: 1, reason: "changed_mind" }],
    });
    expect(res.status).toBeLessThan(300);
    const data = (await res.json()).data;
    expect(data.refundTotal).toBe(UNIT_PRICE);
  });

  it("rejects a fabricated / foreign order id", async () => {
    const res = await returnReq({
      shiftId, terminalId,
      originalOrderId: "00000000-0000-0000-0000-000000000000",
      items: [{ originalLineItemId: "00000000-0000-0000-0000-000000000001", quantity: 1, reason: "other" }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects over-refund (more units than were sold)", async () => {
    const { orderId, lineItemId } = await makeOrder();
    const res = await returnReq({
      shiftId, terminalId, originalOrderId: orderId,
      items: [{ originalLineItemId: lineItemId, quantity: 5, reason: "other" }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a repeat refund of the same units (ledger idempotency)", async () => {
    const { orderId, lineItemId } = await makeOrder();
    const first = await returnReq({
      shiftId, terminalId, originalOrderId: orderId,
      items: [{ originalLineItemId: lineItemId, quantity: 1, reason: "other" }],
    });
    expect(first.status).toBeLessThan(300);
    const second = await returnReq({
      shiftId, terminalId, originalOrderId: orderId,
      items: [{ originalLineItemId: lineItemId, quantity: 1, reason: "other" }],
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});
