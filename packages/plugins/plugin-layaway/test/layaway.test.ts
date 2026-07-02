import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { layawayPlugin, type Layaway } from "../src/index.js";

// Issue #58 — layaway/installment selling had no porulle primitive. A plan
// reserves stock with a deposit, records installments, and at full payment
// completes automatically: a core order is created (cross-linked) and the
// stock hold releases. Forfeit releases the hold and runs the policy hook.
describe("plugin-layaway (issue #58)", () => {
  let app: PluginTestApp["app"];
  let kernel: PluginTestApp["kernel"];
  let entityId: string;
  const forfeited: Layaway[] = [];

  const operator: Actor = {
    type: "user",
    userId: "layaway-op-1",
    email: "op@test.local",
    name: "Operator",
    vendorId: null,
    organizationId: TEST_ORG_ID,
    role: "staff",
    permissions: ["layaway:operate", "layaway:manage", "orders:create", "orders:read", "catalog:create", "inventory:adjust"],
  };

  async function availableStock(): Promise<{ onHand: number; reserved: number }> {
    const levels = await (kernel.services as any).inventory.getLevelsByEntityId(entityId, operator);
    const level = levels.value[0];
    return { onHand: level.quantityOnHand, reserved: level.quantityReserved };
  }

  beforeAll(async () => {
    const built = await createPluginTestApp(
      layawayPlugin({ onForfeit: (l) => void forfeited.push(l) }),
    );
    app = built.app;
    kernel = built.kernel;

    const entity = await (kernel.services as any).catalog.create(
      { type: "product", slug: `e58-${Date.now()}`, metadata: { title: "Bridal saree" } },
      operator,
    );
    entityId = entity.value.id;
    await (kernel.services as any).inventory.adjust(
      { entityId, adjustment: 10, reason: "stock" },
      operator,
    );
  }, 30_000);

  it("full lifecycle: deposit reserves stock, installments accumulate, full payment completes to an order and releases the hold", async () => {
    const create = await app.request("http://localhost/api/layaways", {
      method: "POST",
      headers: jsonHeaders(operator),
      body: JSON.stringify({
        currency: "USD",
        items: [{ entityId, title: "Bridal saree", quantity: 2, unitPrice: 5000 }],
        depositPercent: 20,
        initialPayment: { amount: 2000, method: "cash" },
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()).data;
    const layawayId = created.layaway.id;
    expect(created.layaway.total).toBe(10000);
    expect(created.layaway.depositAmount).toBe(2000);
    expect(created.layaway.paidTotal).toBe(2000);
    expect(created.layaway.status).toBe("active");

    // Stock is held while the plan is active
    let stock = await availableStock();
    expect(stock.reserved).toBe(2);

    // An installment
    const mid = await app.request(`http://localhost/api/layaways/${layawayId}/payments`, {
      method: "POST",
      headers: jsonHeaders(operator),
      body: JSON.stringify({ amount: 3000, method: "card" }),
    });
    expect(mid.status).toBe(201);
    expect((await mid.json()).data.completed).toBe(false);

    // Overpayment is rejected
    const over = await app.request(`http://localhost/api/layaways/${layawayId}/payments`, {
      method: "POST",
      headers: jsonHeaders(operator),
      body: JSON.stringify({ amount: 99999, method: "cash" }),
    });
    expect(over.status).toBeGreaterThanOrEqual(400);

    // Final payment → completed: core order created, hold released
    const final = await app.request(`http://localhost/api/layaways/${layawayId}/payments`, {
      method: "POST",
      headers: jsonHeaders(operator),
      body: JSON.stringify({ amount: 5000, method: "bank" }),
    });
    expect(final.status).toBe(201);
    const done = (await final.json()).data;
    expect(done.completed).toBe(true);
    expect(done.layaway.status).toBe("completed");
    expect(done.layaway.paidTotal).toBe(10000);
    expect(done.layaway.orderId).toBeTruthy();

    stock = await availableStock();
    expect(stock.reserved).toBe(0);

    // The core order exists and is cross-linked
    const order = await (kernel.services as any).orders.getById(done.layaway.orderId, operator);
    expect(order.ok).toBe(true);
    expect(order.value.metadata.layawayId).toBe(layawayId);
    expect(order.value.grandTotal).toBe(10000);

    // Ledger shows all three payments
    const detail = await app.request(`http://localhost/api/layaways/${layawayId}`, {
      method: "GET",
      headers: jsonHeaders(operator),
    });
    const withPayments = (await detail.json()).data;
    expect(withPayments.payments).toHaveLength(3);

    // Completed plans accept no more payments
    const late = await app.request(`http://localhost/api/layaways/${layawayId}/payments`, {
      method: "POST",
      headers: jsonHeaders(operator),
      body: JSON.stringify({ amount: 1, method: "cash" }),
    });
    expect(late.status).toBeGreaterThanOrEqual(400);
  });

  it("forfeit releases the hold and runs the forfeit policy hook", async () => {
    const create = await app.request("http://localhost/api/layaways", {
      method: "POST",
      headers: jsonHeaders(operator),
      body: JSON.stringify({
        currency: "USD",
        items: [{ entityId, title: "Bridal saree", quantity: 1, unitPrice: 5000 }],
      }),
    });
    expect(create.status).toBe(201);
    const layawayId = (await create.json()).data.layaway.id;

    const before = await availableStock();
    expect(before.reserved).toBe(1);

    const forfeit = await app.request(`http://localhost/api/layaways/${layawayId}/forfeit`, {
      method: "POST",
      headers: jsonHeaders(operator),
      body: JSON.stringify({ reason: "expired" }),
    });
    expect(forfeit.status).toBe(201);
    const done = (await forfeit.json()).data;
    expect(done.status).toBe("forfeited");
    expect(done.forfeitReason).toBe("expired");

    const after = await availableStock();
    expect(after.reserved).toBe(0);

    expect(forfeited).toHaveLength(1);
    expect(forfeited[0]!.id).toBe(layawayId);
  });

  it("rejects a plan that cannot be fully reserved", async () => {
    const create = await app.request("http://localhost/api/layaways", {
      method: "POST",
      headers: jsonHeaders(operator),
      body: JSON.stringify({
        currency: "USD",
        items: [{ entityId, title: "Bridal saree", quantity: 9999, unitPrice: 5000 }],
      }),
    });
    expect(create.status).toBeGreaterThanOrEqual(400);
    // Nothing left behind
    const list = await app.request("http://localhost/api/layaways?status=active", {
      method: "GET",
      headers: jsonHeaders(operator),
    });
    expect((await list.json()).data).toHaveLength(0);
  });
});
