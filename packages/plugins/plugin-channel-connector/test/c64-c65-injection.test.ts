import { beforeAll, describe, expect, it } from "vitest";
import {
  createSystemActor,
  runPendingJobs,
  type Actor,
  type PluginTxFn,
} from "@porulle/core";
import { createPluginTestApp, TEST_ORG_ID } from "@porulle/core/testing";
import { and, eq, inArray } from "@porulle/core/drizzle";
import {
  customerAddresses,
  customers,
  commerceJobs,
  orderLineItems,
  orders,
  sellableEntities,
  variants,
} from "@porulle/core/schema";
import {
  channelConnectorPlugin,
  ChannelConnectorService,
  mockChannelConnector,
} from "../src/index.js";
import { channelEntityMap, channelOrderExports } from "../src/schema.js";

const actor: Actor = {
  type: "user",
  userId: "c64-c65-admin",
  email: "c64-c65-admin@test.local",
  name: "C64 C65 Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

describe("channel connector c64/c65 order injection", () => {
  const mock = mockChannelConnector();
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;

  beforeAll(async () => {
    built = await createPluginTestApp(
      channelConnectorPlugin({ connectors: [mock] }),
    );
    service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [mock] },
      built.kernel.database.transaction as PluginTxFn,
    );
  }, 30_000);

  async function connect(storeName: string) {
    const response = await built.app.request(
      "http://localhost/api/channels/stores",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": JSON.stringify(actor),
        },
        body: JSON.stringify({
          provider: "mock",
          credentials: { accessToken: storeName },
          storeDomain: `${storeName}.mock.channel.test`,
          webhookSecret: "secret",
        }),
      },
    );
    expect(response.status).toBe(201);
    return (await response.json()).data as { id: string };
  }

  async function seedEntity(
    storeId: string | null,
    suffix: string,
    withVariant = false,
  ) {
    const entityId = crypto.randomUUID();
    await built.db.insert(sellableEntities).values({
      id: entityId,
      organizationId: TEST_ORG_ID,
      sourceStoreId: storeId,
      type: "product",
      slug: `c64-c65-${suffix}`,
      status: "active",
      isVisible: true,
    });
    let variantId: string | undefined;
    if (withVariant) {
      variantId = crypto.randomUUID();
      await built.db.insert(variants).values({
        id: variantId,
        entityId,
        organizationId: TEST_ORG_ID,
        sourceStoreId: storeId,
        sku: `SKU-${suffix}`,
      });
    }
    return { entityId, variantId };
  }

  async function mapEntity(
    storeId: string,
    entityId: string,
    externalId: string,
    variantId?: string,
  ) {
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId,
      kind: variantId ? "variant" : "entity",
      externalId,
      entityId,
      ...(variantId ? { variantId } : {}),
      syncHash: externalId,
    });
  }

  async function seedOrder(input: {
    lines: Array<{
      entityId: string;
      variantId?: string;
      title?: string;
      totalPrice?: number;
    }>;
    customerId?: string;
    metadata?: Record<string, unknown>;
    status?: string;
  }) {
    const orderId = crypto.randomUUID();
    const total = input.lines.reduce(
      (sum, line) => sum + (line.totalPrice ?? 1000),
      0,
    );
    await built.db.insert(orders).values({
      id: orderId,
      organizationId: TEST_ORG_ID,
      orderNumber: `C64-C65-${orderId.slice(0, 8)}`,
      currency: "USD",
      subtotal: total,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: total,
      status: input.status ?? "pending",
      ...(input.customerId ? { customerId: input.customerId } : {}),
      metadata: input.metadata ?? {},
    });
    await built.db.insert(orderLineItems).values(
      input.lines.map((line) => ({
        orderId,
        entityId: line.entityId,
        entityType: "product",
        ...(line.variantId ? { variantId: line.variantId } : {}),
        title: line.title ?? "Channel Product",
        quantity: 1,
        unitPrice: line.totalPrice ?? 1000,
        totalPrice: line.totalPrice ?? 1000,
      })),
    );
    return orderId;
  }

  async function createOrderThroughService(
    input: Parameters<typeof built.kernel.services.orders.create>[0],
  ) {
    const result = await built.kernel.services.orders.create(
      input,
      actor,
      undefined,
      { trustedPricing: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.value.id;
  }

  async function runJobs() {
    return runPendingJobs({
      db: built.kernel.database.db as Parameters<
        typeof runPendingJobs
      >[0]["db"],
      tasks: new Map(
        (built.kernel.config.jobs?.tasks ?? []).map((task) => [
          task.slug,
          task,
        ]),
      ),
      logger: built.kernel.logger,
      services: built.kernel.services,
      limit: 100,
    });
  }

  it("enqueues one push job per owning store and none for native-only orders", async () => {
    const storeA = await connect("trigger-a");
    const storeB = await connect("trigger-b");
    const channelA = await seedEntity(storeA.id, "trigger-a");
    const channelB = await seedEntity(storeB.id, "trigger-b");
    const native = await seedEntity(null, "trigger-native");
    const orderId = await createOrderThroughService({
      currency: "USD",
      subtotal: 3000,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: 3000,
      lineItems: [
        {
          entityId: channelA.entityId,
          entityType: "product",
          title: "A",
          quantity: 1,
          unitPrice: 1000,
          totalPrice: 1000,
        },
        {
          entityId: channelB.entityId,
          entityType: "product",
          title: "B",
          quantity: 1,
          unitPrice: 1000,
          totalPrice: 1000,
        },
        {
          entityId: native.entityId,
          entityType: "product",
          title: "Native",
          quantity: 1,
          unitPrice: 1000,
          totalPrice: 1000,
        },
      ],
    });
    const nativeOrderId = await createOrderThroughService({
      currency: "USD",
      subtotal: 1000,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: 1000,
      lineItems: [
        {
          entityId: native.entityId,
          entityType: "product",
          title: "Native",
          quantity: 1,
          unitPrice: 1000,
          totalPrice: 1000,
        },
      ],
    });
    const rows = await built.db
      .select()
      .from(orders)
      .where(inArray(orders.id, [orderId, nativeOrderId]));
    expect(rows).toHaveLength(2);
    const jobs = await built.db
      .select()
      .from(commerceJobs)
      .where(eq(commerceJobs.taskSlug, "channel/push-order"));
    const orderJobs = jobs.filter(
      (job) => (job.input as { orderId?: string }).orderId === orderId,
    );
    expect(
      orderJobs.map((job) => (job.input as { storeId: string }).storeId).sort(),
    ).toEqual([storeA.id, storeB.id].sort());
    expect(
      jobs.some(
        (job) => (job.input as { orderId?: string }).orderId === nativeOrderId,
      ),
    ).toBe(false);
  });

  it("builds mapped lines and customer data, then reports missing customer data", async () => {
    const store = await connect("slice");
    const mapped = await seedEntity(store.id, "slice-mapped", true);
    const fallback = await seedEntity(store.id, "slice-fallback");
    await mapEntity(
      store.id,
      mapped.entityId,
      "entity-external",
      mapped.variantId,
    );
    await mapEntity(store.id, mapped.entityId, "variant-external");
    await mapEntity(store.id, fallback.entityId, "fallback-external");
    const customerId = crypto.randomUUID();
    await built.db.insert(customers).values({
      id: customerId,
      organizationId: TEST_ORG_ID,
      userId: `customer-${customerId}`,
      email: "slice@example.test",
      firstName: "Slice",
      lastName: "Customer",
    });
    await built.db.insert(customerAddresses).values([
      {
        customerId,
        type: "shipping",
        isDefault: false,
        firstName: "Wrong",
        lastName: "Address",
        line1: "Old",
        city: "Kandy",
        country: "LK",
      },
      {
        customerId,
        type: "shipping",
        isDefault: true,
        firstName: "Slice",
        lastName: "Customer",
        line1: "Default",
        city: "Colombo",
        country: "LK",
      },
    ]);
    const orderId = await seedOrder({
      customerId,
      lines: [
        {
          entityId: mapped.entityId,
          ...(mapped.variantId ? { variantId: mapped.variantId } : {}),
          totalPrice: 1200,
        },
        { entityId: fallback.entityId, totalPrice: 800 },
      ],
    });
    const slice = await service.buildOrderSlice(TEST_ORG_ID, store.id, orderId);
    expect(slice).toMatchObject({
      ok: true,
      value: {
        grandTotal: 2000,
        lines: [
          { externalVariantId: "entity-external" },
          { externalVariantId: "fallback-external" },
        ],
        customer: {
          email: "slice@example.test",
          name: "Slice Customer",
          shippingAddress: { address1: "Default", city: "Colombo" },
        },
      },
    });

    const guestEntity = await seedEntity(store.id, "slice-guest");
    await mapEntity(store.id, guestEntity.entityId, "guest-external");
    const guestOrder = await seedOrder({
      lines: [{ entityId: guestEntity.entityId }],
      metadata: {
        guestCustomer: {
          email: "guest@example.test",
          name: "Guest Shopper",
          shippingAddress: { city: "Galle", country: "LK" },
        },
      },
    });
    const guestSlice = await service.buildOrderSlice(
      TEST_ORG_ID,
      store.id,
      guestOrder,
    );
    expect(guestSlice).toMatchObject({
      ok: true,
      value: {
        customer: {
          email: "guest@example.test",
          name: "Guest Shopper",
          shippingAddress: { city: "Galle" },
        },
      },
    });

    const missingOrder = await seedOrder({
      lines: [{ entityId: guestEntity.entityId }],
    });
    const missing = await service.buildOrderSlice(
      TEST_ORG_ID,
      store.id,
      missingOrder,
    );
    expect(missing).toMatchObject({ ok: false, code: "CUSTOMER_DATA_MISSING" });
  });

  it("runs push-order jobs to confirmed exports, independently per store", async () => {
    const storeA = await connect("job-a");
    const storeB = await connect("job-b");
    const entityA = await seedEntity(storeA.id, "job-a");
    const entityB = await seedEntity(storeB.id, "job-b");
    await mapEntity(storeA.id, entityA.entityId, "job-external-a");
    await mapEntity(storeB.id, entityB.entityId, "job-external-b");
    const orderId = await seedOrder({
      lines: [
        { entityId: entityA.entityId, totalPrice: 1100 },
        { entityId: entityB.entityId, totalPrice: 900 },
      ],
      metadata: {
        customer: { email: "job@example.test", name: "Job Shopper" },
        shippingAddress: { city: "Colombo", country: "LK" },
      },
    });
    const jobs = (
      built.kernel.services as unknown as {
        jobs: {
          enqueue: (
            task: string,
            input: Record<string, unknown>,
            options: { organizationId: string; concurrencyKey: string },
          ) => Promise<string>;
        };
      }
    ).jobs;
    await jobs.enqueue(
      "channel/push-order",
      { orgId: TEST_ORG_ID, storeId: storeA.id, orderId },
      {
        organizationId: TEST_ORG_ID,
        concurrencyKey: `test:${orderId}:${storeA.id}`,
      },
    );
    await jobs.enqueue(
      "channel/push-order",
      { orgId: TEST_ORG_ID, storeId: storeB.id, orderId },
      {
        organizationId: TEST_ORG_ID,
        concurrencyKey: `test:${orderId}:${storeB.id}`,
      },
    );
    const result = await runJobs();
    expect(result.failed).toBe(0);
    const exports = await built.db
      .select()
      .from(channelOrderExports)
      .where(
        and(
          eq(channelOrderExports.organizationId, TEST_ORG_ID),
          eq(channelOrderExports.orderId, orderId),
        ),
      );
    expect(exports).toHaveLength(2);
    expect(exports.map((row) => [row.storeId, row.state])).toEqual(
      expect.arrayContaining([
        [storeA.id, "confirmed"],
        [storeB.id, "confirmed"],
      ]),
    );
  });

  it("reaps definitive and expired transient exports through the real refund service", async () => {
    const store = await connect("reaper");
    const entity = await seedEntity(store.id, "reaper");
    await mapEntity(store.id, entity.entityId, "reaper-external");
    const definitiveOrder = await seedOrder({
      lines: [{ entityId: entity.entityId }],
      status: "fulfilled",
    });
    const youngTransientOrder = await seedOrder({
      lines: [{ entityId: entity.entityId }],
      status: "fulfilled",
    });
    const oldTransientOrder = await seedOrder({
      lines: [{ entityId: entity.entityId }],
      status: "fulfilled",
    });
    const confirmedOrder = await seedOrder({
      lines: [{ entityId: entity.entityId }],
      status: "fulfilled",
    });
    await built.db
      .update(orders)
      .set({ amountCaptured: 1000 })
      .where(
        inArray(orders.id, [
          definitiveOrder,
          youngTransientOrder,
          oldTransientOrder,
          confirmedOrder,
        ]),
      );

    const definitive = await service.createExport(
      TEST_ORG_ID,
      store.id,
      definitiveOrder,
    );
    const youngTransient = await service.createExport(
      TEST_ORG_ID,
      store.id,
      youngTransientOrder,
    );
    const oldTransient = await service.createExport(
      TEST_ORG_ID,
      store.id,
      oldTransientOrder,
    );
    const confirmed = await service.createExport(
      TEST_ORG_ID,
      store.id,
      confirmedOrder,
    );
    expect(
      definitive.ok && youngTransient.ok && oldTransient.ok && confirmed.ok,
    ).toBe(true);
    if (
      !definitive.ok ||
      !youngTransient.ok ||
      !oldTransient.ok ||
      !confirmed.ok
    )
      return;
    await service.transitionExport(
      TEST_ORG_ID,
      definitive.value.id,
      "exported",
      "test",
    );
    await service.transitionExport(
      TEST_ORG_ID,
      definitive.value.id,
      "failed",
      "test",
      "definitive",
      "definitive",
    );
    await service.transitionExport(
      TEST_ORG_ID,
      youngTransient.value.id,
      "exported",
      "test",
    );
    await service.transitionExport(
      TEST_ORG_ID,
      youngTransient.value.id,
      "failed",
      "test",
      "transient",
      "transient",
    );
    await service.transitionExport(
      TEST_ORG_ID,
      oldTransient.value.id,
      "exported",
      "test",
    );
    await service.transitionExport(
      TEST_ORG_ID,
      oldTransient.value.id,
      "failed",
      "test",
      "transient",
      "transient",
    );
    await service.transitionExport(
      TEST_ORG_ID,
      confirmed.value.id,
      "exported",
      "test",
    );
    await service.transitionExport(
      TEST_ORG_ID,
      confirmed.value.id,
      "confirmed",
      "test",
    );
    const old = new Date(Date.now() - 10_000);
    const now = new Date();
    await built.db
      .update(channelOrderExports)
      .set({ updatedAt: old })
      .where(
        inArray(channelOrderExports.id, [
          definitive.value.id,
          oldTransient.value.id,
        ]),
      );
    await built.db
      .update(channelOrderExports)
      .set({ updatedAt: now })
      .where(eq(channelOrderExports.id, youngTransient.value.id));

    const first = await service.reapExports({
      definitiveMs: 5_000,
      transientMs: 20_000,
    });
    expect(first.refundedOrderIds).toContain(definitiveOrder);
    const young = await service.getExport(TEST_ORG_ID, youngTransient.value.id);
    expect(young.ok && young.value.state).toBe("failed");
    const confirmedRow = await service.getExport(
      TEST_ORG_ID,
      confirmed.value.id,
    );
    expect(confirmedRow.ok && confirmedRow.value.state).toBe("confirmed");
    const oldTransientRow = await service.getExport(
      TEST_ORG_ID,
      oldTransient.value.id,
    );
    expect(oldTransientRow.ok && oldTransientRow.value.state).toBe("failed");
    const second = await service.reapExports({
      definitiveMs: 5_000,
      transientMs: 0,
    });
    expect(second.refundedOrderIds).toContain(oldTransientOrder);
    const statuses = await built.db
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(
        inArray(orders.id, [
          definitiveOrder,
          oldTransientOrder,
          youngTransientOrder,
        ]),
      );
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: definitiveOrder, status: "refunded" },
        { id: oldTransientOrder, status: "refunded" },
        { id: youngTransientOrder, status: "refunded" },
      ]),
    );
  });
});
