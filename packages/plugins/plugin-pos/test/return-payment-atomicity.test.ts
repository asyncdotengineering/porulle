import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, posAdminActor } from "./test-utils.js";
import { posPlugin } from "../src/index.js";
import { markOrderPaidForTest } from "@porulle/core/testing";

const UNIT_PRICE = 3000;

/** Actor with permissions to create paid orders and process returns. */
const returnActor: Actor = {
  ...posAdminActor,
  permissions: [
    ...posAdminActor.permissions,
    "orders:create",
    "orders:read",
    "orders:update",
    "catalog:create",
    "catalog:read:unpublished",
    "pricing:manage",
  ],
};

describe("POS return — refund ledger bound to payout (475ace30)", () => {
  let app: PluginTestApp["app"];
  let kernel: PluginTestApp["kernel"];
  let terminalId: string;
  let shiftId: string;
  let entityId: string;

  async function makeOrder(quantity = 1) {
    const order = await (kernel.services as any).orders.create(
      {
        currency: "USD",
        subtotal: UNIT_PRICE * quantity,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: UNIT_PRICE * quantity,
        lineItems: [{
          entityId,
          entityType: "product",
          title: "Saree",
          quantity,
          unitPrice: UNIT_PRICE,
          totalPrice: UNIT_PRICE * quantity,
          taxAmount: 0,
        }],
      },
      returnActor,
    );
    expect(order.ok).toBe(true);
    await markOrderPaidForTest(kernel, order.value.id, UNIT_PRICE * quantity);
    return { orderId: order.value.id, lineItemId: order.value.lineItems[0].id };
  }

  async function getRefundedQuantity(orderId: string, lineItemId: string): Promise<number> {
    const order = await (kernel.services as any).orders.getById(orderId, returnActor);
    expect(order.ok).toBe(true);
    const line = order.value.lineItems.find((l: { id: string }) => l.id === lineItemId);
    expect(line).toBeDefined();
    return line.refundedQuantity;
  }

  const returnReq = (body: unknown) =>
    app.request("http://localhost/api/pos/returns", {
      method: "POST",
      headers: jsonHeaders(returnActor),
      body: JSON.stringify(body),
    });

  const returnPaymentReq = (returnId: string, body: unknown) =>
    app.request(`http://localhost/api/pos/returns/${returnId}/payments`, {
      method: "POST",
      headers: jsonHeaders(returnActor),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const built = await createPluginTestApp(posPlugin());
    app = built.app;
    kernel = built.kernel;

    const entity = await (kernel.services as any).catalog.create(
      { type: "product", slug: `ret475-${Date.now()}`, metadata: { title: "Saree" } },
      returnActor,
    );
    expect(entity.ok).toBe(true);
    entityId = entity.value.id;

    await (kernel.services as any).pricing.setBasePrice(
      { entityId, currency: "USD", amount: UNIT_PRICE },
      returnActor,
    );

    const t = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "RET-475", code: "R475" }),
    });
    terminalId = (await t.json()).data.id;

    const s = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(returnActor),
      body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    shiftId = (await s.json()).data.id;
  }, 30_000);

  it("creates a return with payment, updating refundedQuantity and recording a POS payment row", async () => {
    const { orderId, lineItemId } = await makeOrder();
    expect(await getRefundedQuantity(orderId, lineItemId)).toBe(0);

    const res = await returnReq({
      shiftId,
      terminalId,
      originalOrderId: orderId,
      items: [{ originalLineItemId: lineItemId, quantity: 1, reason: "changed_mind" }],
      payment: { method: "cash", amount: UNIT_PRICE },
    });
    expect(res.status).toBeLessThan(300);
    const data = (await res.json()).data;
    expect(data.refundTotal).toBe(UNIT_PRICE);
    expect(data.payment.amount).toBe(UNIT_PRICE);
    expect(data.payment.method).toBe("cash");

    expect(await getRefundedQuantity(orderId, lineItemId)).toBe(1);
  });

  it("rejects payment above refundTotal without mutating refundedQuantity (atomicity)", async () => {
    const { orderId, lineItemId } = await makeOrder();
    expect(await getRefundedQuantity(orderId, lineItemId)).toBe(0);

    const res = await returnReq({
      shiftId,
      terminalId,
      originalOrderId: orderId,
      items: [{ originalLineItemId: lineItemId, quantity: 1, reason: "other" }],
      payment: { method: "cash", amount: UNIT_PRICE + 1 },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await getRefundedQuantity(orderId, lineItemId)).toBe(0);
  });

  it("rejects a repeat refund of the same units", async () => {
    const { orderId, lineItemId } = await makeOrder();

    const first = await returnReq({
      shiftId,
      terminalId,
      originalOrderId: orderId,
      items: [{ originalLineItemId: lineItemId, quantity: 1, reason: "other" }],
      payment: { method: "cash", amount: UNIT_PRICE },
    });
    expect(first.status).toBeLessThan(300);

    const second = await returnReq({
      shiftId,
      terminalId,
      originalOrderId: orderId,
      items: [{ originalLineItemId: lineItemId, quantity: 1, reason: "other" }],
      payment: { method: "cash", amount: UNIT_PRICE },
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("supports split tender and rejects follow-up payments above refundTotal", async () => {
    const { orderId, lineItemId } = await makeOrder();
    const half = Math.floor(UNIT_PRICE / 2);

    const res = await returnReq({
      shiftId,
      terminalId,
      originalOrderId: orderId,
      items: [{ originalLineItemId: lineItemId, quantity: 1, reason: "changed_mind" }],
      payment: { method: "cash", amount: half },
    });
    expect(res.status).toBeLessThan(300);
    const data = (await res.json()).data;
    const returnId = data.transaction.id;

    const second = await returnPaymentReq(returnId, { method: "card", amount: UNIT_PRICE - half });
    expect(second.status).toBeLessThan(300);

    const over = await returnPaymentReq(returnId, { method: "cash", amount: 1 });
    expect(over.status).toBeGreaterThanOrEqual(400);
  });
});
