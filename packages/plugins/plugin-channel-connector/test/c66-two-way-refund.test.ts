import { beforeAll, describe, expect, it } from "vitest";
import { runPendingJobs } from "@porulle/core";
import type { ChannelEvent } from "@porulle/core";
import { createPluginTestApp, TEST_ORG_ID, createTestActor } from "@porulle/core/testing";
import { and, eq } from "@porulle/core/drizzle";
import { inventoryLevels, orderLineItems, orderRefunds, orders, sellableEntities, variants } from "@porulle/core/schema";
import { channelConnectorPlugin, mockChannelConnector, ChannelConnectorService } from "../src/index.js";
import { channelEntityMap, channelOrderExports, channelRefundRequests, connectedStores } from "../src/schema.js";

const actor = createTestActor({
  userId: "c66-operator",
  email: "c66@test.local",
  name: "c66 Operator",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});

describe("channel connector c66 two-way sync and refunds", () => {
  const mock = mockChannelConnector({ catalog: [] });
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock], refundAutoMax: 1000, newStoreDays: 7 }));
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [mock], refundAutoMax: 1000, newStoreDays: 7 });
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

  /** Delivers to the per-store address, then runs the job the delivery queued. */
  async function webhook(storeId: string, eventId: string, data: ChannelEvent | Record<string, never>, signature = "c66-secret") {
    const response = await built.app.request(`http://localhost/api/channels/webhooks/${storeId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-signature": signature },
      body: JSON.stringify({ id: eventId, type: "kind" in data ? data.kind : "empty", data }),
    });
    await runPendingJobs({
      db: built.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
      tasks: new Map((built.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
      logger: built.kernel.logger,
      services: built.kernel.services,
      limit: 100,
    });
    return response;
  }
  const refund = (suffix: string): ChannelEvent => ({ kind: "refund.created", remoteOrderId: `remote-order-${suffix}`, remoteRefundId: `remote-refund-${suffix}`, lines: [{ externalVariantId: `remote-variant-${suffix}`, quantity: 1 }] });

  it("rejects bad HMAC, accepts a valid webhook, and deduplicates replay", async () => {
    const store = await connect("hmac");
    const deletion: ChannelEvent = { kind: "product.deleted", externalIds: ["none"] };
    expect((await webhook(store.id, "bad-1", deletion, "wrong")).status).toBe(401);
    expect((await webhook(store.id, "good-1", deletion)).status).toBe(200);
    const duplicate = await webhook(store.id, "good-1", deletion);
    expect(await duplicate.json()).toEqual({ data: { received: true, duplicate: true } });
  });

  it("soft-archives a mapped entity on product deletion", async () => {
    const store = await connect("delete");
    const entityId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: store.id, type: "product", slug: "c66-delete", status: "active", isVisible: true });
    await built.db.insert(channelEntityMap).values({ organizationId: TEST_ORG_ID, storeId: store.id, kind: "entity", externalId: "remote-delete", entityId, syncHash: "delete" });
    expect((await webhook(store.id, "delete-1", { kind: "product.deleted", externalIds: ["remote-delete"] })).status).toBe(200);
    const [entity] = await built.db.select({ status: sellableEntities.status }).from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(entity?.status).toBe("archived");
  });

  it("level-sets a mapped variant's stock from an inventory change", async () => {
    const store = await connect("update");
    const seeded = await seedMappedPaidOrder(store.id, "update");
    expect((await webhook(store.id, "update-1", { kind: "inventory.changed", levels: [{ externalId: "remote-variant-update", available: 7 }] })).status).toBe(200);
    const [level] = await built.db.select({ quantity: inventoryLevels.quantityOnHand }).from(inventoryLevels).where(and(eq(inventoryLevels.entityId, seeded.entityId), eq(inventoryLevels.variantId, seeded.variantId)));
    expect(level?.quantity).toBe(7);
  });

  it("executes a verified refund through the real order refund ledger", async () => {
    const store = await connect("auto");
    const seeded = await seedMappedPaidOrder(store.id, "auto");
    const response = await webhook(store.id, "refund-auto", refund("auto"));
    expect(response.status).toBe(200);
    const refunds = await built.db.select().from(orderRefunds).where(eq(orderRefunds.orderId, seeded.orderId));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.amount).toBe(1000);
    const [line] = await built.db.select({ refundedQuantity: orderLineItems.refundedQuantity }).from(orderLineItems).where(eq(orderLineItems.id, seeded.lineId));
    expect(line?.refundedQuantity).toBe(1);
  });

  // Approval marks the request approved BEFORE executing. If the execution then fails, a request left
  // `approved` can never be approved again ("already handled") and the money never moves.
  it("an approval whose execution fails leaves the request approvable again", async () => {
    const store = await connect("retry");
    const seeded = await seedMappedPaidOrder(store.id, "retry", 2000);
    expect((await webhook(store.id, "refund-retry", refund("retry"))).status).toBe(200);
    const [request] = await built.db.select().from(channelRefundRequests).where(and(eq(channelRefundRequests.storeId, store.id), eq(channelRefundRequests.remoteRefundId, "remote-refund-retry")));
    // A cancelled order refuses a line refund: the execution fails.
    await built.db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, seeded.orderId));
    const failed = await built.app.request(`http://localhost/api/channels/refund-requests/${request!.id}/approve`, { method: "POST", headers: { "x-test-actor": JSON.stringify(actor) } });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const [after] = await built.db.select().from(channelRefundRequests).where(eq(channelRefundRequests.id, request!.id));
    expect(after?.state).toBe("requested");
    await built.db.update(orders).set({ status: "confirmed" }).where(eq(orders.id, seeded.orderId));
    const retried = await built.app.request(`http://localhost/api/channels/refund-requests/${request!.id}/approve`, { method: "POST", headers: { "x-test-actor": JSON.stringify(actor) } });
    expect(retried.status).toBe(201);
    expect(await built.db.select().from(orderRefunds).where(eq(orderRefunds.orderId, seeded.orderId))).toHaveLength(1);
  });

  it("an automatic refund whose execution fails waits for an operator instead of sticking as approved", async () => {
    const store = await connect("autofail");
    const seeded = await seedMappedPaidOrder(store.id, "autofail");
    await built.db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, seeded.orderId));
    await webhook(store.id, "refund-autofail", refund("autofail"));
    const [request] = await built.db.select().from(channelRefundRequests).where(and(eq(channelRefundRequests.storeId, store.id), eq(channelRefundRequests.remoteRefundId, "remote-refund-autofail")));
    expect(request?.state).toBe("requested");
  });

  it("queues an over-threshold refund without moving money, then approval executes it", async () => {
    const store = await connect("approval");
    const seeded = await seedMappedPaidOrder(store.id, "approval", 2000);
    expect((await webhook(store.id, "refund-approval", refund("approval"))).status).toBe(200);
    const [request] = await built.db.select().from(channelRefundRequests).where(and(eq(channelRefundRequests.storeId, store.id), eq(channelRefundRequests.remoteRefundId, "remote-refund-approval")));
    expect(request?.state).toBe("requested");
    expect(await built.db.select().from(orderRefunds).where(eq(orderRefunds.orderId, seeded.orderId))).toHaveLength(0);
    const approved = await built.app.request(`http://localhost/api/channels/refund-requests/${request!.id}/approve`, { method: "POST", headers: { "x-test-actor": JSON.stringify(actor) } });
    expect(approved.status).toBe(201);
    expect((await approved.json()).data.state).toBe("executed");
    expect(await built.db.select().from(orderRefunds).where(eq(orderRefunds.orderId, seeded.orderId))).toHaveLength(1);
  });
});
