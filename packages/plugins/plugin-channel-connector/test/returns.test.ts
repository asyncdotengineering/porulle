/**
 * A shopper's return reaches the store, and the store's answer comes back.
 *
 * The marketplace asks the store to take items back (Shopify: `returnRequest`), naming each line by
 * the store's own variant id and the quantity; the store approves, declines or closes it, and says so
 * on `returns/*`. The refund itself arrives separately on `refunds/create`. A return for a line the
 * store has no record of is refused before anything is asked of the store.
 *
 * Written before the implementation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Err, Ok, type ChannelReturnInput } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { orderLineItems, orderRefunds, orders, sellableEntities, variants } from "@porulle/core/schema";
import { createPluginTestApp, createTestActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, channelOrderExports, channelReturns } from "../src/schema.js";

const actor = createTestActor({
  userId: "returns-admin",
  email: "returns@test.local",
  name: "Returns Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});

const base = mockChannelConnector({ catalog: [] });
const asked: Array<{ remoteOrderId: string; input: ChannelReturnInput }> = [];
let nextReturn = 600;
const connector = {
  ...base,
  async requestReturn(_store: unknown, remoteOrderId: string, input: ChannelReturnInput) {
    asked.push({ remoteOrderId, input });
    nextReturn += 1;
    return Ok({ remoteReturnId: String(nextReturn) });
  },
};

describe("a shopper's return", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let storeId: string;
  const entityId = crypto.randomUUID();
  const shirt = crypto.randomUUID();
  const dress = crypto.randomUUID();

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ provider: "mock", credentials: { accessToken: "returns" }, storeDomain: "returns.mock.channel.test", webhookSecret: "secret" }),
    });
    storeId = ((await response.json()) as { data: { id: string } }).data.id;
    await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, type: "product", slug: "returns-product", status: "active", isVisible: true });
    await built.db.insert(variants).values([
      { id: shirt, organizationId: TEST_ORG_ID, entityId, sku: "RET-SHIRT", status: "active", sortOrder: 0 },
      { id: dress, organizationId: TEST_ORG_ID, entityId, sku: "RET-DRESS", status: "active", sortOrder: 1 },
    ]);
    // Only the shirt is mapped: the dress is a line the store has no record of.
    await built.db.insert(channelEntityMap).values({ organizationId: TEST_ORG_ID, storeId, kind: "variant", externalId: "701", entityId, variantId: shirt, syncHash: "fixture" });
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  }, 30_000);

  async function shippedOrder(): Promise<{ orderId: string; shirtLine: string; dressLine: string }> {
    const created = await built.kernel.services.orders.create({
      currency: "USD", subtotal: 3000, taxTotal: 0, shippingTotal: 0, grandTotal: 3000, status: "pending",
      lineItems: [
        { entityId, variantId: shirt, entityType: "product", title: "Shirt", quantity: 2, unitPrice: 1000, totalPrice: 2000 },
        { entityId, variantId: dress, entityType: "product", title: "Dress", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
    }, actor, undefined, { trustedPricing: true });
    if (!created.ok) throw new Error(created.error.message);
    await built.db.insert(channelOrderExports).values({ organizationId: TEST_ORG_ID, storeId, orderId: created.value.id, state: "confirmed", remoteOrderId: "9100" });
    const lines = await built.db.select({ id: orderLineItems.id, variantId: orderLineItems.variantId }).from(orderLineItems).where(eq(orderLineItems.orderId, created.value.id));
    return { orderId: created.value.id, shirtLine: lines.find((line) => line.variantId === shirt)?.id ?? "", dressLine: lines.find((line) => line.variantId === dress)?.id ?? "" };
  }

  it("R1: asks the store to take back the named quantity, by the store's own variant id, and records the return as requested", async () => {
    const { orderId, shirtLine } = await shippedOrder();
    asked.length = 0;
    const requested = await service.requestReturn(TEST_ORG_ID, orderId, { lines: [{ orderLineItemId: shirtLine, quantity: 1 }], reason: "Too small", note: "Fits tight" });
    expect(requested.ok).toBe(true);
    expect(asked).toEqual([{ remoteOrderId: "9100", input: { lines: [{ externalVariantId: "701", quantity: 1 }], reason: "Too small", note: "Fits tight" } }]);
    const rows = await built.db.select().from(channelReturns).where(eq(channelReturns.orderId, orderId));
    expect(rows.map((row) => ({ status: row.status, remote: row.remoteReturnId, lines: row.lines }))).toEqual([{ status: "requested", remote: String(nextReturn), lines: [{ orderLineItemId: shirtLine, quantity: 1 }] }]);
  });

  it("R2: a line the store has no record of is refused before the store is asked anything", async () => {
    const { orderId, dressLine } = await shippedOrder();
    asked.length = 0;
    const refused = await service.requestReturn(TEST_ORG_ID, orderId, { lines: [{ orderLineItemId: dressLine, quantity: 1 }], reason: "Wrong colour" });
    expect(refused.ok).toBe(false);
    expect(asked).toEqual([]);
  });

  it("R3: the store's returns/approve, then returns/close, move the return; an unknown return changes nothing", async () => {
    const { orderId, shirtLine } = await shippedOrder();
    const requested = await service.requestReturn(TEST_ORG_ID, orderId, { lines: [{ orderLineItemId: shirtLine, quantity: 2 }], reason: "Changed my mind" });
    if (!requested.ok) throw new Error(requested.error);
    const remote = requested.value.remoteReturnId;
    const statusOf = async () => (await built.db.select({ status: channelReturns.status }).from(channelReturns).where(eq(channelReturns.remoteReturnId, remote)))[0]?.status;
    expect((await service.handleWebhook(TEST_ORG_ID, storeId, { id: `evt-approve-${remote}`, type: "returns/approve", data: { kind: "return.updated", remoteReturnId: remote, status: "approved" } })).ok).toBe(true);
    expect(await statusOf()).toBe("approved");
    expect((await service.handleWebhook(TEST_ORG_ID, storeId, { id: `evt-close-${remote}`, type: "returns/close", data: { kind: "return.updated", remoteReturnId: remote, status: "closed" } })).ok).toBe(true);
    expect(await statusOf()).toBe("closed");
    expect((await service.handleWebhook(TEST_ORG_ID, storeId, { id: "evt-decline-unknown", type: "returns/decline", data: { kind: "return.updated", remoteReturnId: "999999", status: "declined" } })).ok).toBe(true);
    expect(await statusOf()).toBe("closed");
  });

  describe("a return held for the merchant to decide", () => {
    let storeBooks = true;
    let heldService: ChannelConnectorService;

    beforeAll(() => {
      const { requestReturn: _notAsked, ...withoutRequest } = connector;
      heldService = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [{
        ...withoutRequest,
        async recordRefund() {
          return storeBooks ? Ok({ remoteRefundId: crypto.randomUUID() }) : Err({ code: "CHANNEL_DOWN", message: "the store is down" });
        },
      }] });
    });

    async function heldReturn(): Promise<{ id: string; orderId: string; shirtLine: string }> {
      const { orderId, shirtLine } = await shippedOrder();
      await built.db.update(orders).set({ status: "fulfilled" }).where(eq(orders.id, orderId));
      const requested = await heldService.requestReturn(TEST_ORG_ID, orderId, { lines: [{ orderLineItemId: shirtLine, quantity: 1 }], reason: "Too small" });
      if (!requested.ok) throw new Error(requested.error);
      return { id: requested.value.id, orderId, shirtLine };
    }
    const refundsOf = (orderId: string) => built.db.select({ id: orderRefunds.id }).from(orderRefunds).where(eq(orderRefunds.orderId, orderId));
    const statusOf = async (id: string) => (await built.db.select({ status: channelReturns.status }).from(channelReturns).where(eq(channelReturns.id, id)))[0]?.status;

    it("H1: two approvals at once refund one unit of a two-unit line once", async () => {
      const { id, orderId, shirtLine } = await heldReturn();
      const answers = await Promise.all([heldService.approveReturn(TEST_ORG_ID, id), heldService.approveReturn(TEST_ORG_ID, id)]);
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      expect(await refundsOf(orderId)).toHaveLength(1);
      const [line] = await built.db.select({ refunded: orderLineItems.refundedQuantity }).from(orderLineItems).where(eq(orderLineItems.id, shirtLine));
      expect(line?.refunded).toBe(1);
    });

    it("H2: a decline that arrives after the approval claimed the return changes nothing", async () => {
      const { id, orderId } = await heldReturn();
      const approved = await heldService.approveReturn(TEST_ORG_ID, id);
      expect(approved.ok).toBe(true);
      expect((await heldService.declineReturn(TEST_ORG_ID, id)).ok).toBe(false);
      expect(await statusOf(id)).toBe("closed");
      expect(await refundsOf(orderId)).toHaveLength(1);
    });

    it("H3: when the store will not book it, approving again books it and does not pay the shopper twice", async () => {
      const { id, orderId } = await heldReturn();
      storeBooks = false;
      expect((await heldService.approveReturn(TEST_ORG_ID, id)).ok).toBe(false);
      expect(await statusOf(id)).toBe("approved");
      storeBooks = true;
      expect((await heldService.approveReturn(TEST_ORG_ID, id)).ok).toBe(true);
      expect(await statusOf(id)).toBe("closed");
      expect(await refundsOf(orderId)).toHaveLength(1);
    });

    it("H4: a crash after the claim and before the refund still pays the shopper on the next approval", async () => {
      const { id, orderId } = await heldReturn();
      await built.db.update(channelReturns).set({ status: "approved" }).where(eq(channelReturns.id, id));
      expect((await heldService.approveReturn(TEST_ORG_ID, id)).ok).toBe(true);
      expect(await refundsOf(orderId)).toHaveLength(1);
    });
  });
});
