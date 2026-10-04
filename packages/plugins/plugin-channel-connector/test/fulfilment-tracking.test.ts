/**
 * When a store ships, the shopper gets the parcel's carrier, number and link.
 *
 * Shopify's `orders/fulfilled` and `orders/partially_fulfilled` bodies are the order, carrying its
 * `fulfillments` — each with `tracking_company`, `tracking_number`, `tracking_url` and the lines it
 * shipped. Each store fulfilment becomes ONE core fulfilment record (a replay adds none), recorded
 * before the order moves so whatever the move announces can read it. A partial shipment records only
 * its own lines and leaves the order partially fulfilled.
 *
 * Written before the implementation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "@porulle/core/drizzle";
import { fulfillmentLineItems, fulfillmentRecords, orders, sellableEntities, variants } from "@porulle/core/schema";
import { createPluginTestApp, createTestActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, channelOrderExports } from "../src/schema.js";

const actor = createTestActor({
  userId: "tracking-admin",
  email: "tracking@test.local",
  name: "Tracking Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});
const connector = mockChannelConnector({ catalog: [] });

type TestApp = Awaited<ReturnType<typeof createPluginTestApp>>;

describe("a store's fulfilment reaches the shopper as tracking", () => {
  let built: TestApp;
  let storeId: string;
  let service: ChannelConnectorService;
  const product = { entityId: crypto.randomUUID(), shirt: crypto.randomUUID(), dress: crypto.randomUUID() };
  let remoteSeq = 8000;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ provider: "mock", credentials: { accessToken: "tracking" }, storeDomain: "tracking.mock.channel.test", webhookSecret: "secret" }),
    });
    expect(response.status).toBe(201);
    storeId = ((await response.json()) as { data: { id: string } }).data.id;
    await built.db.insert(sellableEntities).values({ id: product.entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, type: "product", slug: "tracking-product", status: "active", isVisible: true });
    await built.db.insert(variants).values([
      { id: product.shirt, organizationId: TEST_ORG_ID, entityId: product.entityId, sku: "TRACK-SHIRT", status: "active", sortOrder: 0 },
      { id: product.dress, organizationId: TEST_ORG_ID, entityId: product.entityId, sku: "TRACK-DRESS", status: "active", sortOrder: 1 },
    ]);
    await built.db.insert(channelEntityMap).values([
      { organizationId: TEST_ORG_ID, storeId, kind: "variant", externalId: "501", entityId: product.entityId, variantId: product.shirt, syncHash: "fixture" },
      { organizationId: TEST_ORG_ID, storeId, kind: "variant", externalId: "502", entityId: product.entityId, variantId: product.dress, syncHash: "fixture" },
    ]);
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  }, 30_000);

  async function exportedOrder(): Promise<{ orderId: string; remoteId: number }> {
    const created = await built.kernel.services.orders.create({
      currency: "USD", subtotal: 3000, taxTotal: 0, shippingTotal: 0, grandTotal: 3000, status: "pending",
      lineItems: [
        { entityId: product.entityId, variantId: product.shirt, entityType: "product", title: "Shirt", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { entityId: product.entityId, variantId: product.dress, entityType: "product", title: "Dress", quantity: 1, unitPrice: 2000, totalPrice: 2000 },
      ],
    }, actor, undefined, { trustedPricing: true });
    if (!created.ok) throw new Error(created.error.message);
    const confirmed = await built.kernel.services.orders.changeStatus({ orderId: created.value.id, newStatus: "confirmed" }, actor);
    if (!confirmed.ok) throw new Error(confirmed.error.message);
    remoteSeq += 1;
    await built.db.insert(channelOrderExports).values({ organizationId: TEST_ORG_ID, storeId, orderId: created.value.id, state: "confirmed", remoteOrderId: String(remoteSeq) });
    return { orderId: created.value.id, remoteId: remoteSeq };
  }

  const fulfilment = (id: number, variantIds: number[], tracking: { company: string; number: string; url: string }) => ({
    id,
    status: "success",
    tracking_company: tracking.company,
    tracking_number: tracking.number,
    tracking_url: tracking.url,
    line_items: variantIds.map((variantId) => ({ id: variantId * 10, variant_id: variantId, quantity: 1 })),
  });
  const deliver = (type: string, remoteId: number, fulfillments: unknown[], eventId: string) =>
    service.handleWebhook(TEST_ORG_ID, storeId, { id: eventId, type, data: { id: remoteId, fulfillments } });
  const recordsOf = async (orderId: string) => built.db.select().from(fulfillmentRecords).where(eq(fulfillmentRecords.orderId, orderId));
  const statusOf = async (orderId: string) => (await built.db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)))[0]?.status;

  it("T1+T2: orders/fulfilled records the parcel's carrier, number and link once, and fulfils the order — a replay adds nothing", async () => {
    const { orderId, remoteId } = await exportedOrder();
    const parcel = fulfilment(91, [501, 502], { company: "DHL Express", number: "JD0123", url: "https://track.example/JD0123" });
    expect((await deliver("orders/fulfilled", remoteId, [parcel], "evt-t1")).ok).toBe(true);
    const records = await recordsOf(orderId);
    expect(records.map((record) => ({ carrier: record.carrier, trackingNumber: record.trackingNumber, trackingUrl: record.trackingUrl, status: record.status })))
      .toEqual([{ carrier: "DHL Express", trackingNumber: "JD0123", trackingUrl: "https://track.example/JD0123", status: "shipped" }]);
    expect(await statusOf(orderId)).toBe("fulfilled");

    expect((await deliver("orders/fulfilled", remoteId, [parcel], "evt-t1-replay")).ok).toBe(true);
    expect((await recordsOf(orderId)).length).toBe(1);
  });

  it("T3+T4: a partial shipment records only its own line and leaves the order partially fulfilled; the rest ships as a second parcel", async () => {
    const { orderId, remoteId } = await exportedOrder();
    const first = fulfilment(92, [501], { company: "Pronto", number: "PR-1", url: "https://track.example/PR-1" });
    expect((await deliver("orders/partially_fulfilled", remoteId, [first], "evt-t3")).ok).toBe(true);
    const afterFirst = await recordsOf(orderId);
    expect(afterFirst.map((record) => record.trackingNumber)).toEqual(["PR-1"]);
    const shippedLines = await built.db.select().from(fulfillmentLineItems).where(eq(fulfillmentLineItems.fulfillmentId, afterFirst[0]?.id ?? ""));
    expect(shippedLines.length).toBe(1);
    expect(await statusOf(orderId)).toBe("partially_fulfilled");

    const second = fulfilment(93, [502], { company: "Pronto", number: "PR-2", url: "https://track.example/PR-2" });
    expect((await deliver("orders/fulfilled", remoteId, [first, second], "evt-t4")).ok).toBe(true);
    expect((await recordsOf(orderId)).map((record) => record.trackingNumber).sort()).toEqual(["PR-1", "PR-2"]);
    expect(await statusOf(orderId)).toBe("fulfilled");
  });

  it("T5: a fulfilment the store cancelled is not a parcel", async () => {
    const { orderId, remoteId } = await exportedOrder();
    const cancelled = { ...fulfilment(94, [501, 502], { company: "DHL Express", number: "VOID-1", url: "https://track.example/VOID-1" }), status: "cancelled" };
    const live = fulfilment(95, [501, 502], { company: "DHL Express", number: "LIVE-1", url: "https://track.example/LIVE-1" });
    expect((await deliver("orders/fulfilled", remoteId, [cancelled, live], "evt-t5")).ok).toBe(true);
    expect((await recordsOf(orderId)).map((record) => record.trackingNumber)).toEqual(["LIVE-1"]);
  });
});
