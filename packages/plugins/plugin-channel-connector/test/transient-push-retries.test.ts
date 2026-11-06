/**
 * A store that blips while an order is pushed must not strand the order.
 *
 * `exportOrder` records a retriable failure and returns it as a value, so a job that only throws on
 * an error result ended successfully and nothing ever pushed the order again.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Err, runPendingJobs } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { commerceJobs, sellableEntities, variants } from "@porulle/core/schema";
import { createPluginTestApp, createTestActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, channelOrderExports } from "../src/schema.js";

const actor = createTestActor({
  userId: "transient-push-admin",
  email: "transient-push@test.local",
  name: "Transient Push Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});

const base = mockChannelConnector({ catalog: [] });
let storeIsDown = true;
const connector = {
  ...base,
  async pushOrder(...args: Parameters<typeof base.pushOrder>) {
    if (storeIsDown) return Err({ code: "CHANNEL_UNAVAILABLE", message: "store answered 503", retriable: true });
    return base.pushOrder(...args);
  },
};

describe("a transient push failure", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let entityId: string;
  const variantId = crypto.randomUUID();

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ provider: "mock", credentials: { accessToken: "transient" }, storeDomain: "transient.mock.channel.test", webhookSecret: "secret" }),
    });
    const storeId = ((await response.json()) as { data: { id: string } }).data.id;
    entityId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, type: "product", slug: "transient-product", status: "active" });
    await built.db.insert(variants).values({ id: variantId, organizationId: TEST_ORG_ID, entityId, sku: "TRANSIENT", status: "active", sortOrder: 0 });
    await built.db.insert(channelEntityMap).values({ organizationId: TEST_ORG_ID, storeId, kind: "variant", externalId: "801", entityId, variantId, syncHash: "fixture" });
  }, 30_000);

  const runJobs = () => runPendingJobs({
    db: built.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
    tasks: new Map((built.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
    logger: built.kernel.logger,
    services: built.kernel.services,
    limit: 100,
  });

  it("T1: fails the job so it is retried, and the retry pushes the order", async () => {
    const created = await built.kernel.services.orders.create({
      currency: "USD", subtotal: 1000, taxTotal: 0, shippingTotal: 0, grandTotal: 1000, status: "pending_payment",
      metadata: {
        customer: { email: "shopper@test.local", name: "Ama Perera" },
        shippingAddress: { firstName: "Ama", lastName: "Perera", line1: "12 Galle Road", city: "Colombo", postalCode: "00300", countryCode: "LK", country: "LK" },
      },
      lineItems: [{ entityId, variantId, entityType: "product", title: "Channel Product", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    }, actor, undefined, { trustedPricing: true });
    if (!created.ok) throw new Error(created.error.message);
    const confirmed = await built.kernel.services.orders.changeStatus({ orderId: created.value.id, newStatus: "confirmed" }, actor);
    if (!confirmed.ok) throw new Error(confirmed.error.message);
    const exportOf = async () => (await built.db.select().from(channelOrderExports).where(eq(channelOrderExports.orderId, created.value.id)))[0];

    await runJobs();
    expect((await exportOf())?.state).toBe("failed");
    expect((await exportOf())?.lastError).toContain("503");
    expect((await exportOf())?.failureKind).toBe("transient");
    const [job] = await built.db.select({ status: commerceJobs.status, attempts: commerceJobs.attempts }).from(commerceJobs).where(eq(commerceJobs.taskSlug, "channel/push-order"));
    expect(job).toEqual({ status: "pending", attempts: 1 });

    storeIsDown = false;
    await built.db.update(commerceJobs).set({ waitUntil: new Date(0) }).where(eq(commerceJobs.status, "pending"));
    await runJobs();
    expect((await exportOf())?.state).not.toBe("failed");
    expect((await exportOf())?.remoteOrderId).not.toBeNull();
  });
});
