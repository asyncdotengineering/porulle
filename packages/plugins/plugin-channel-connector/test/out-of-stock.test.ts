/**
 * A store that refuses an order for stock cancels the platform order.
 *
 * Stock is checked at checkout but not held, so a paid order can reach a store that no longer has the
 * item. The store's refusal is definitive: nobody will send it. Left as a failed export, the shopper
 * has paid for nothing; cancelled, the host's cancel path refunds them. Any OTHER refusal (a missing
 * variant, a bad address) stays a failed export for an operator, because those can be fixed and retried.
 *
 * Written before the implementation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_OUT_OF_STOCK, Err, type ChannelOrderSlice } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { orders, sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, createTestActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelOrderExports } from "../src/schema.js";

const actor = createTestActor({
  userId: "oos-admin",
  email: "oos@test.local",
  name: "Out Of Stock Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});

const base = mockChannelConnector({ catalog: [] });
let refusal: { code: string; message: string } = { code: CHANNEL_OUT_OF_STOCK, message: "Not enough stock." };
const connector = {
  ...base,
  async pushOrder() {
    return Err({ ...refusal, retriable: false });
  },
};

describe("a store refusing an order", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let storeId: string;
  let entityId: string;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ provider: "mock", credentials: { accessToken: "oos" }, storeDomain: "oos.mock.channel.test", webhookSecret: "secret" }),
    });
    storeId = ((await response.json()) as { data: { id: string } }).data.id;
    entityId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, type: "product", slug: "oos-product", status: "active", isVisible: true });
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  }, 30_000);

  async function paidOrder(): Promise<string> {
    const created = await built.kernel.services.orders.create({
      currency: "USD", subtotal: 1000, taxTotal: 0, shippingTotal: 0, grandTotal: 1000, status: "pending_payment",
      lineItems: [{ entityId, entityType: "product", title: "Last one", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
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
    lines: [{ externalVariantId: "1", title: "Last one", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    customer: { name: "Nimali Perera", email: "nimali@example.test", shippingAddress: { firstName: "Nimali", lastName: "Perera", line1: "12 Galle Road", city: "Colombo", countryCode: "LK" } },
  });
  const statusOf = async (orderId: string) => (await built.db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)))[0]?.status;
  const exportOf = async (orderId: string) => (await built.db.select({ state: channelOrderExports.state, failureKind: channelOrderExports.failureKind }).from(channelOrderExports).where(eq(channelOrderExports.orderId, orderId)))[0];

  it("O1: refused for stock — the export fails for good and the platform order is cancelled", async () => {
    refusal = { code: CHANNEL_OUT_OF_STOCK, message: "Not enough stock." };
    const orderId = await paidOrder();
    await service.exportOrder(TEST_ORG_ID, storeId, slice(orderId), actor);
    expect(await exportOf(orderId)).toEqual({ state: "failed", failureKind: "definitive" });
    expect(await statusOf(orderId)).toBe("cancelled");
  });

  it("O2: refused for any other reason — the export fails and the order stands for an operator", async () => {
    refusal = { code: "SHOPIFY_ORDER_REJECTED", message: "Variant does not exist." };
    const orderId = await paidOrder();
    await service.exportOrder(TEST_ORG_ID, storeId, slice(orderId), actor);
    expect((await exportOf(orderId))?.state).toBe("failed");
    expect(await statusOf(orderId)).toBe("confirmed");
  });
});
