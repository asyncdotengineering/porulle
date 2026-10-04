/**
 * A cancelled order is cancelled at the store too — and the store gets a veto.
 *
 * The marketplace cancels first only when the store agrees: a store that refuses (it has shipped)
 * must leave the platform order exactly as it was, or the shopper is refunded for goods on their way.
 * The other direction: a merchant cancelling in their store cancels the platform order, without the
 * platform turning round and cancelling at the store again. And an order cancelled before its push
 * ran is never pushed — the store would otherwise receive an order nobody is paying for.
 *
 * Written before the implementation. Every refusal row has a positive twin.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_CANCEL_REFUSED, Err, Ok, runPendingJobs, type ChannelCancelOrderInput } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { orderStatusHistory, orders, sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, createTestActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelOrderExports } from "../src/schema.js";

const actor = createTestActor({
  userId: "order-cancel-admin",
  email: "order-cancel@test.local",
  name: "Order Cancel Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});

const base = mockChannelConnector({ catalog: [] });
const cancelCalls: Array<{ remoteId: string; input: ChannelCancelOrderInput }> = [];
const pushedOrderIds: string[] = [];
let storeRefuses = false;
const connector = {
  ...base,
  async pushOrder(...args: Parameters<typeof base.pushOrder>) {
    pushedOrderIds.push(args[1].orderId);
    return base.pushOrder(...args);
  },
  async cancelOrder(_store: unknown, remoteId: string, input: ChannelCancelOrderInput) {
    cancelCalls.push({ remoteId, input });
    return storeRefuses
      ? Err({ code: CHANNEL_CANCEL_REFUSED, message: "The order has been fulfilled.", retriable: false })
      : Ok(undefined);
  },
};

type TestApp = Awaited<ReturnType<typeof createPluginTestApp>>;

describe("cancelling an order that was pushed to a store", () => {
  let built: TestApp;
  let storeId: string;
  let entityId: string;
  let remoteSeq = 7000;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ provider: "mock", credentials: { accessToken: "cancel" }, storeDomain: "cancel.mock.channel.test", webhookSecret: "secret" }),
    });
    expect(response.status).toBe(201);
    storeId = ((await response.json()) as { data: { id: string } }).data.id;
    entityId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, type: "product", slug: "order-cancel-product", status: "active", isVisible: true });
  }, 30_000);

  async function confirmedOrder(): Promise<string> {
    const created = await built.kernel.services.orders.create({
      currency: "USD", subtotal: 1000, taxTotal: 0, shippingTotal: 0, grandTotal: 1000, status: "pending_payment",
      lineItems: [{ entityId, entityType: "product", title: "Channel Product", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    }, actor, undefined, { trustedPricing: true });
    if (!created.ok) throw new Error(created.error.message);
    const confirmed = await built.kernel.services.orders.changeStatus({ orderId: created.value.id, newStatus: "confirmed" }, actor);
    if (!confirmed.ok) throw new Error(confirmed.error.message);
    return created.value.id;
  }

  async function exported(orderId: string): Promise<string> {
    remoteSeq += 1;
    const remoteOrderId = String(remoteSeq);
    await built.db.insert(channelOrderExports).values({ organizationId: TEST_ORG_ID, storeId, orderId, state: "confirmed", remoteOrderId });
    return remoteOrderId;
  }

  async function cancel(orderId: string, reason: string): Promise<boolean> {
    try {
      const result = await built.kernel.services.orders.changeStatus({ orderId, newStatus: "cancelled", reason }, actor);
      return result.ok;
    } catch {
      return false;
    }
  }

  const status = async (orderId: string) =>
    (await built.db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)))[0]?.status;
  const runJobs = () => runPendingJobs({
    db: built.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
    tasks: new Map((built.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
    logger: built.kernel.logger,
    services: built.kernel.services,
    limit: 100,
  });

  it("C1: a shopper's cancel cancels the order at the store first, by its remote id, as the customer's", async () => {
    const orderId = await confirmedOrder();
    const remoteOrderId = await exported(orderId);
    cancelCalls.length = 0;
    expect(await cancel(orderId, "shopper_cancelled")).toBe(true);
    expect(await status(orderId)).toBe("cancelled");
    expect(cancelCalls).toEqual([{ remoteId: remoteOrderId, input: expect.objectContaining({ reason: "customer" }) }]);
  });

  it("C2: a store that refuses (it has shipped) leaves the platform order as it was — and its twin cancels", async () => {
    const refused = await confirmedOrder();
    await exported(refused);
    storeRefuses = true;
    expect(await cancel(refused, "shopper_cancelled")).toBe(false);
    storeRefuses = false;
    expect(await status(refused)).toBe("confirmed");

    const accepted = await confirmedOrder();
    await exported(accepted);
    expect(await cancel(accepted, "shopper_cancelled")).toBe(true);
    expect(await status(accepted)).toBe("cancelled");
  });

  it("C3: the store's orders/cancelled cancels the platform order without cancelling at the store again", async () => {
    const orderId = await confirmedOrder();
    const remoteOrderId = await exported(orderId);
    cancelCalls.length = 0;
    const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
    const handled = await service.handleWebhook(TEST_ORG_ID, storeId, { id: `evt-${remoteOrderId}`, type: "orders/cancelled", data: { id: Number(remoteOrderId) } });
    expect(handled.ok).toBe(true);
    expect(await status(orderId)).toBe("cancelled");
    expect(cancelCalls).toEqual([]);

    // C4: delivered again (or after a platform cancel), it changes nothing and fails nothing.
    const historyBefore = await built.db.select().from(orderStatusHistory).where(and(eq(orderStatusHistory.orderId, orderId), eq(orderStatusHistory.toStatus, "cancelled")));
    const replay = await service.handleWebhook(TEST_ORG_ID, storeId, { id: `evt-${remoteOrderId}-again`, type: "orders/cancelled", data: { id: Number(remoteOrderId) } });
    expect(replay.ok).toBe(true);
    const historyAfter = await built.db.select().from(orderStatusHistory).where(and(eq(orderStatusHistory.orderId, orderId), eq(orderStatusHistory.toStatus, "cancelled")));
    expect(historyAfter.length).toBe(historyBefore.length);
  });

  it("C5: an order cancelled before its push ran is never exported — and an order left alone is", async () => {
    await runJobs();
    const cancelled = await confirmedOrder();
    expect(await cancel(cancelled, "shopper_cancelled")).toBe(true);
    const kept = await confirmedOrder();
    await runJobs();
    const exportsOf = async (orderId: string) =>
      (await built.db.select({ id: channelOrderExports.id }).from(channelOrderExports).where(eq(channelOrderExports.orderId, orderId))).length;
    expect(await exportsOf(kept)).toBe(1);
    expect(await exportsOf(cancelled)).toBe(0);
    expect(pushedOrderIds).not.toContain(cancelled);
  });
});
