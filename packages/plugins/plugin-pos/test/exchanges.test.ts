import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  posAdminActor,
  TEST_ORG_ID,
} from "./test-utils.js";
import { posPlugin } from "../src/index.js";

// Issue #53 — plugin-pos had returns but no exchange primitive. An exchange
// (return lines + replacement order + net delta) is one call: the refund on
// the original order (issue #52 primitives) and the replacement order are
// created in ONE database transaction, cross-linked for audit; an even
// exchange completes with zero net payment.
describe("POS exchanges (issue #53)", () => {
  let app: PluginTestApp["app"];
  let kernel: PluginTestApp["kernel"];
  let terminalId: string;
  let shiftId: string;
  let entityId: string;

  // Exchange touches core orders, so the actor carries order scopes too.
  const exchangeActor: Actor = {
    ...posAdminActor,
    permissions: [
      ...posAdminActor.permissions,
      "orders:create",
      "orders:read",
      "orders:update",
      "catalog:create",
    ],
  };

  async function createOrder(): Promise<{ orderId: string; lineItemId: string }> {
    const result = await (kernel.services as any).orders.create(
      {
        currency: "USD",
        subtotal: 2000,
        taxTotal: 200,
        shippingTotal: 0,
        grandTotal: 2200,
        lineItems: [
          { entityId, entityType: "product", title: "Saree M", quantity: 2, unitPrice: 1000, totalPrice: 2000, taxAmount: 200 },
        ],
      },
      exchangeActor,
    );
    expect(result.ok).toBe(true);
    return { orderId: result.value.id, lineItemId: result.value.lineItems[0].id };
  }

  beforeAll(async () => {
    const built = await createPluginTestApp(posPlugin());
    app = built.app;
    kernel = built.kernel;

    const entity = await (kernel.services as any).catalog.create(
      { type: "product", slug: `e53-${Date.now()}`, metadata: { title: "Saree" } },
      exchangeActor,
    );
    expect(entity.ok).toBe(true);
    entityId = entity.value.id;

    const t = await app.request("http://localhost/api/pos/terminals", {
      method: "POST",
      headers: jsonHeaders(posAdminActor),
      body: JSON.stringify({ name: "Register 1", code: "R1" }),
    });
    terminalId = (await t.json()).data.id;

    const s = await app.request("http://localhost/api/pos/shifts/open", {
      method: "POST",
      headers: jsonHeaders(exchangeActor),
      body: JSON.stringify({ terminalId, openingFloat: 10000 }),
    });
    shiftId = (await s.json()).data.id;
  }, 30_000);

  it("an even exchange completes in one call with zero net payment and full audit linkage", async () => {
    const { orderId, lineItemId } = await createOrder();

    const res = await app.request("http://localhost/api/pos/exchanges", {
      method: "POST",
      headers: jsonHeaders(exchangeActor),
      body: JSON.stringify({
        shiftId,
        terminalId,
        originalOrderId: orderId,
        currency: "USD",
        returnItems: [
          { originalLineItemId: lineItemId, quantity: 1, reason: "wrong_item" },
        ],
        // Same value as the returned unit: (2000+200)/2 = 1100
        replacementItems: [
          { entityId, title: "Saree L", quantity: 1, unitPrice: 1000, taxAmount: 100 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(data.returnTotal).toBe(1100);
    expect(data.replacementTotal).toBe(1100);
    expect(data.netDelta).toBe(0);
    // Even exchange → the POS transaction is completed immediately
    expect(data.transaction.status).toBe("completed");
    expect(data.transaction.type).toBe("exchange");
    expect(data.transaction.orderId).toBe(data.replacementOrderId);

    // Original order: line-level refund recorded via issue #52 primitives
    const refunds = await (kernel.services as any).orders.listRefunds(orderId, exchangeActor);
    expect(refunds.ok).toBe(true);
    expect(refunds.value).toHaveLength(1);
    expect(refunds.value[0].id).toBe(data.refundId);
    expect(refunds.value[0].reason).toBe("exchange");

    const original = await (kernel.services as any).orders.getById(orderId, exchangeActor);
    const line = original.value.lineItems.find((l: any) => l.id === lineItemId);
    expect(line.refundedQuantity).toBe(1);

    // Replacement order: cross-linked back to the original + refund
    const replacement = await (kernel.services as any).orders.getById(data.replacementOrderId, exchangeActor);
    expect(replacement.ok).toBe(true);
    expect(replacement.value.metadata.exchange.originalOrderId).toBe(orderId);
    expect(replacement.value.metadata.exchange.refundId).toBe(data.refundId);
    expect(replacement.value.grandTotal).toBe(1100);
  });

  it("an uneven exchange stays open with the net delta to settle", async () => {
    const { orderId, lineItemId } = await createOrder();

    const res = await app.request("http://localhost/api/pos/exchanges", {
      method: "POST",
      headers: jsonHeaders(exchangeActor),
      body: JSON.stringify({
        shiftId,
        terminalId,
        originalOrderId: orderId,
        currency: "USD",
        returnItems: [
          { originalLineItemId: lineItemId, quantity: 1, reason: "changed_mind" },
        ],
        // More expensive replacement: 1500 vs 1100 returned → customer owes 400
        replacementItems: [
          { entityId, title: "Saree XL Premium", quantity: 1, unitPrice: 1500 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(data.netDelta).toBe(1500 - 1100);
    expect(data.transaction.status).toBe("open"); // awaiting tender
    expect(data.transaction.total).toBe(400);
  });

  it("rejects an exchange whose return exceeds the refundable quantity — atomically, creating nothing", async () => {
    const { orderId, lineItemId } = await createOrder();

    const before = await (kernel.services as any).orders.list({ page: 1, limit: 100 }, exchangeActor);
    const countBefore = before.value.items.length;

    const res = await app.request("http://localhost/api/pos/exchanges", {
      method: "POST",
      headers: jsonHeaders(exchangeActor),
      body: JSON.stringify({
        shiftId,
        terminalId,
        originalOrderId: orderId,
        returnItems: [
          { originalLineItemId: lineItemId, quantity: 5, reason: "other" }, // only 2 on the line
        ],
        replacementItems: [
          { entityId, title: "Saree", quantity: 1, unitPrice: 1000 },
        ],
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Nothing was created: no refund ledger row, no replacement order
    const refunds = await (kernel.services as any).orders.listRefunds(orderId, exchangeActor);
    expect(refunds.value).toHaveLength(0);
    const after = await (kernel.services as any).orders.list({ page: 1, limit: 100 }, exchangeActor);
    expect(after.value.items.length).toBe(countBefore);
    // org id sanity so the count comparison is meaningful
    expect(TEST_ORG_ID).toBeTruthy();
  });
});
