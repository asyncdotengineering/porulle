/**
 * A store that completes an order the moment it arrives has still received it.
 *
 * WooCommerce completes an order of virtual or downloadable items on arrival, and its status read then
 * answers `fulfilled`. The push only moved the export on `confirmed`, so such an order stayed `exported`
 * forever although the store had it and had finished it (measured live, 2026-10-05).
 *
 * Written before the implementation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Ok, type ChannelOrderSlice, type ChannelOrderStatus } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, createTestActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelOrderExports } from "../src/schema.js";

const actor = createTestActor({
  userId: "arrival-admin",
  email: "arrival@test.local",
  name: "Arrival Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});

const base = mockChannelConnector({ catalog: [] });
let remote: ChannelOrderStatus["status"] = "fulfilled";
const connector = {
  ...base,
  async fetchOrderStatus() {
    return Ok({ status: remote });
  },
};

describe("a store that completes an order on arrival", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let storeId: string;
  let entityId: string;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ provider: "mock", credentials: { accessToken: "arrival" }, storeDomain: "arrival.mock.channel.test", webhookSecret: "secret" }),
    });
    storeId = ((await response.json()) as { data: { id: string } }).data.id;
    entityId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, type: "product", slug: "arrival-product", status: "active", isVisible: true });
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  }, 30_000);

  async function paidOrder(): Promise<string> {
    const created = await built.kernel.services.orders.create({
      currency: "USD", subtotal: 1000, taxTotal: 0, shippingTotal: 0, grandTotal: 1000, status: "pending_payment",
      lineItems: [{ entityId, entityType: "product", title: "A download", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    }, actor, undefined, { trustedPricing: true });
    if (!created.ok) throw new Error(created.error.message);
    const confirmed = await built.kernel.services.orders.changeStatus({ orderId: created.value.id, newStatus: "confirmed" }, actor);
    if (!confirmed.ok) throw new Error(confirmed.error.message);
    return created.value.id;
  }

  const slice = (orderId: string): ChannelOrderSlice => ({
    orderId,
    currency: "USD",
    grandTotal: 1000,
    lines: [{ externalVariantId: "1", title: "A download", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    customer: { name: "Nimali Perera", email: "nimali@example.test", shippingAddress: { firstName: "Nimali", lastName: "Perera", line1: "12 Galle Road", city: "Colombo", countryCode: "LK" } },
  });
  const exportOf = async (orderId: string) => (await built.db.select({ state: channelOrderExports.state, lastError: channelOrderExports.lastError }).from(channelOrderExports).where(eq(channelOrderExports.orderId, orderId)))[0];

  it("A1: the store answers fulfilled after the push — the export is confirmed", async () => {
    remote = "fulfilled";
    const orderId = await paidOrder();
    const result = await service.exportOrder(TEST_ORG_ID, storeId, slice(orderId), actor);
    expect(result.ok).toBe(true);
    expect(await exportOf(orderId)).toEqual({ state: "confirmed", lastError: null });
  });

  it("A2 (control): the store answers confirmed — the export is confirmed, as before", async () => {
    remote = "confirmed";
    const orderId = await paidOrder();
    await service.exportOrder(TEST_ORG_ID, storeId, slice(orderId), actor);
    expect((await exportOf(orderId))?.state).toBe("confirmed");
  });

  it("A3 (control): the store answers pending — the export stays exported for a later read", async () => {
    remote = "pending";
    const orderId = await paidOrder();
    await service.exportOrder(TEST_ORG_ID, storeId, slice(orderId), actor);
    expect((await exportOf(orderId))?.state).toBe("exported");
  });
});
