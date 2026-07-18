import { beforeAll, describe, expect, it } from "vitest";
import type { Actor, PluginTxFn } from "@porulle/core";
import { createPluginTestApp, TEST_ORG_ID } from "@porulle/core/testing";
import { and, eq } from "@porulle/core/drizzle";
import { inventoryLevels, orderLineItems, orderRefunds, orders, sellableEntities, variants } from "@porulle/core/schema";
import { channelConnectorPlugin, mockChannelConnector, ChannelConnectorService } from "../src/index.js";
import { channelEntityMap, channelOrderExports, channelRefundRequests, connectedStores } from "../src/schema.js";

const actor: Actor = {
  type: "user",
  userId: "c66-operator",
  email: "c66@test.local",
  name: "c66 Operator",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

describe("channel connector c66 two-way sync and refunds", () => {
  const mock = mockChannelConnector();
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock], refundAutoMax: 1000, newStoreDays: 7 }));
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [mock], refundAutoMax: 1000, newStoreDays: 7 }, built.kernel.database.transaction as PluginTxFn);
  }, 30_000);

  async function connect(name: string) {
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": JSON.stringify(actor) },
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: `${name}.test`, webhookSecret: "c66-secret" }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).data as { id: string };
  }

  async function seedMappedPaidOrder(storeId: string, suffix: string, amount = 1000) {
    const entityId = crypto.randomUUID();
    const variantId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, type: "product", slug: `c66-${suffix}`, status: "active", isVisible: true });
    await built.db.insert(variants).values({ id: variantId, entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, sku: `C66-${suffix}` });
    await built.db.insert(channelEntityMap).values({ organizationId: TEST_ORG_ID, storeId, kind: "variant", externalId: `remote-variant-${suffix}`, entityId, variantId, syncHash: suffix });
    await built.db.insert(orders).values({ id: orderId, organizationId: TEST_ORG_ID, orderNumber: `C66-${suffix}`, status: "confirmed", currency: "USD", subtotal: amount, taxTotal: 0, shippingTotal: 0, grandTotal: amount, amountCaptured: amount });
    const [line] = await built.db.insert(orderLineItems).values({ orderId, entityId, variantId, entityType: "product", title: `C66 ${suffix}`, quantity: 1, unitPrice: amount, totalPrice: amount }).returning();
    const created = await service.createExport(TEST_ORG_ID, storeId, orderId);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("export seed failed");
    await built.db.update(channelOrderExports).set({ remoteOrderId: `remote-order-${suffix}` }).where(eq(channelOrderExports.id, created.value.id));
    await built.db.update(connectedStores).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(connectedStores.id, storeId));
    return { orderId, lineId: line!.id, entityId, variantId };
  }

  async function webhook(storeId: string, eventId: string, data: Record<string, unknown>, type = "refunds/create", signature = "c66-secret") {
    return built.app.request(`http://localhost/api/channels/webhooks/${storeId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-signature": signature },
      body: JSON.stringify({ id: eventId, type, data }),
    });
  }

  it("rejects bad HMAC, accepts a valid webhook, and deduplicates replay", async () => {
    const store = await connect("hmac");
    expect((await webhook(store.id, "bad-1", {}, "products/delete", "wrong")).status).toBe(401);
    expect((await webhook(store.id, "good-1", {}, "products/delete")).status).toBe(200);
    const duplicate = await webhook(store.id, "good-1", {}, "products/delete");
    expect(await duplicate.json()).toEqual({ data: { received: true, duplicate: true } });
  });

  it("soft-archives a mapped entity on product deletion", async () => {
    const store = await connect("delete");
    const entityId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: store.id, type: "product", slug: "c66-delete", status: "active", isVisible: true });
    await built.db.insert(channelEntityMap).values({ organizationId: TEST_ORG_ID, storeId: store.id, kind: "entity", externalId: "remote-delete", entityId, syncHash: "delete" });
    expect((await webhook(store.id, "delete-1", { id: "remote-delete" }, "products/delete")).status).toBe(200);
    const [entity] = await built.db.select({ status: sellableEntities.status }).from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(entity?.status).toBe("archived");
  });

  it("level-sets a mapped inventory quantity from a product update webhook", async () => {
    const store = await connect("update");
    const seeded = await seedMappedPaidOrder(store.id, "update");
    await built.db.insert(channelEntityMap).values({ organizationId: TEST_ORG_ID, storeId: store.id, kind: "entity", externalId: "remote-product-update", entityId: seeded.entityId, syncHash: "product" });
    expect((await webhook(store.id, "update-1", { id: "remote-product-update", variants: [{ id: "remote-variant-update", inventory_quantity: 7 }] }, "products/update")).status).toBe(200);
    const [level] = await built.db.select({ quantity: inventoryLevels.quantityOnHand }).from(inventoryLevels).where(and(eq(inventoryLevels.entityId, seeded.entityId), eq(inventoryLevels.variantId, seeded.variantId)));
    expect(level?.quantity).toBe(7);
  });

  it("executes a verified refund through the real order refund ledger", async () => {
    const store = await connect("auto");
    const seeded = await seedMappedPaidOrder(store.id, "auto");
    const response = await webhook(store.id, "refund-auto", { id: "remote-refund-auto", order_id: "remote-order-auto", line_items: [{ variant_id: "remote-variant-auto", quantity: 1 }] });
    expect(response.status).toBe(200);
    const refunds = await built.db.select().from(orderRefunds).where(eq(orderRefunds.orderId, seeded.orderId));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.amount).toBe(1000);
    const [line] = await built.db.select({ refundedQuantity: orderLineItems.refundedQuantity }).from(orderLineItems).where(eq(orderLineItems.id, seeded.lineId));
    expect(line?.refundedQuantity).toBe(1);
  });

  it("queues an over-threshold refund without moving money, then approval executes it", async () => {
    const store = await connect("approval");
    const seeded = await seedMappedPaidOrder(store.id, "approval", 2000);
    expect((await webhook(store.id, "refund-approval", { id: "remote-refund-approval", order_id: "remote-order-approval", line_items: [{ variant_id: "remote-variant-approval", quantity: 1 }] })).status).toBe(200);
    const [request] = await built.db.select().from(channelRefundRequests).where(and(eq(channelRefundRequests.storeId, store.id), eq(channelRefundRequests.remoteRefundId, "remote-refund-approval")));
    expect(request?.state).toBe("requested");
    expect(await built.db.select().from(orderRefunds).where(eq(orderRefunds.orderId, seeded.orderId))).toHaveLength(0);
    const approved = await built.app.request(`http://localhost/api/channels/refund-requests/${request!.id}/approve`, { method: "POST", headers: { "x-test-actor": JSON.stringify(actor) } });
    expect(approved.status).toBe(201);
    expect((await approved.json()).data.state).toBe("executed");
    expect(await built.db.select().from(orderRefunds).where(eq(orderRefunds.orderId, seeded.orderId))).toHaveLength(1);
  });
});
