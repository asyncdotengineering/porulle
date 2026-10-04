import { beforeAll, describe, expect, it } from "vitest";
import {
  createSystemActor,
  runPendingJobs,
  type Actor,
} from "@porulle/core";
import {createPluginTestApp, TEST_ORG_ID, createTestActor } from "@porulle/core/testing";
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

const actor = createTestActor({
  userId: "c64-c65-admin",
  email: "c64-c65-admin@test.local",
  name: "C64 C65 Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});

describe("channel connector c64/c65 order injection", () => {
  const mock = mockChannelConnector({ catalog: [] });
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
    shippingTotal?: number;
    discountTotal?: number;
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
      shippingTotal: input.shippingTotal ?? 0,
      discountTotal: input.discountTotal ?? 0,
      grandTotal: total + (input.shippingTotal ?? 0) - (input.discountTotal ?? 0),
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
          shippingAddress: { line1: "Default", city: "Colombo", countryCode: "LK" },
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
          shippingAddress: { firstName: "Address", lastName: "Shopper", line1: "3 Guest Road", city: "Galle", countryCode: "LK" },
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

  // The ORDER's address is where the shopper asked to be delivered: typed at checkout, or a
  // non-default saved address they picked. The customer's saved default was set first and the order's
  // address read only when it was missing, so a store was sent the default: a wrong-address
  // fulfilment (found on the deployed checkout, 2026-09-25). The default is only a fallback.
  // Found on a real Shopify store: a shopper paid Rs 24,900 + Rs 350 delivery, and the merchant's
  // order read Rs 24,900 with no shipping line, because the slice total was the sum of its lines.
  it("carries the order's delivery charge when the slice is the whole order, and only then", async () => {
    const store = await connect("shipping");
    const other = await connect("shipping-other");
    const product = await seedEntity(store.id, "shipping-product");
    const elsewhere = await seedEntity(other.id, "shipping-elsewhere");
    await mapEntity(store.id, product.entityId, "shipping-external");
    await mapEntity(other.id, elsewhere.entityId, "shipping-elsewhere-external");
    const metadata = { customer: { email: "ship@example.test", name: "Ship Shopper" }, shippingAddress: { firstName: "Ship", lastName: "Shopper", line1: "45 Flower Road", city: "Colombo", countryCode: "LK" } };

    // S1: one store's whole order, with delivery: the slice carries it and its total includes it.
    const whole = await seedOrder({ lines: [{ entityId: product.entityId, totalPrice: 24900 }], shippingTotal: 350, metadata });
    const wholeSlice = await service.buildOrderSlice(TEST_ORG_ID, store.id, whole);
    expect(wholeSlice).toMatchObject({ ok: true, value: { grandTotal: 25250, shipping: { title: "Shipping", amount: 350 } } });

    // S2: no delivery charge: no shipping on the slice, total unchanged.
    const free = await seedOrder({ lines: [{ entityId: product.entityId, totalPrice: 24900 }], metadata });
    const freeSlice = await service.buildOrderSlice(TEST_ORG_ID, store.id, free);
    expect(freeSlice.ok && freeSlice.value.grandTotal).toBe(24900);
    expect(freeSlice.ok && "shipping" in freeSlice.value).toBe(false);

    // S3: an order spanning two stores: one charge cannot be split honestly, so neither slice
    // claims it and each total is its own lines.
    const split = await seedOrder({ lines: [{ entityId: product.entityId, totalPrice: 24900 }, { entityId: elsewhere.entityId, totalPrice: 1000 }], shippingTotal: 350, metadata });
    const splitSlice = await service.buildOrderSlice(TEST_ORG_ID, store.id, split);
    expect(splitSlice.ok && splitSlice.value.grandTotal).toBe(24900);
    expect(splitSlice.ok && "shipping" in splitSlice.value).toBe(false);
  });

  // A shopper who used a promo code paid less than the lines and delivery. Without the discount on
  // the slice the store's order reads more than was paid, and its total never matches the payment.
  it("carries the order's discount and its code when the slice is the whole order, and only then", async () => {
    const store = await connect("discount");
    const other = await connect("discount-other");
    const product = await seedEntity(store.id, "discount-product");
    const elsewhere = await seedEntity(other.id, "discount-elsewhere");
    await mapEntity(store.id, product.entityId, "discount-external");
    await mapEntity(other.id, elsewhere.entityId, "discount-elsewhere-external");
    const address = { customer: { email: "save@example.test", name: "Save Shopper" }, shippingAddress: { firstName: "Save", lastName: "Shopper", line1: "45 Flower Road", city: "Colombo", countryCode: "LK" } };

    // D1: the whole order, discounted by a code: the slice says which code and how much, and its
    // total is what the shopper paid — lines plus delivery, minus the discount.
    const coded = await seedOrder({ lines: [{ entityId: product.entityId, totalPrice: 24900 }], shippingTotal: 350, discountTotal: 2490, metadata: { ...address, promotionCode: "SAVE10" } });
    const codedSlice = await service.buildOrderSlice(TEST_ORG_ID, store.id, coded);
    expect(codedSlice).toMatchObject({ ok: true, value: { grandTotal: 22760, discount: { code: "SAVE10", amount: 2490 } } });

    // D2: a discount nobody typed a code for (an automatic promotion) still reaches the store, named.
    const automatic = await seedOrder({ lines: [{ entityId: product.entityId, totalPrice: 24900 }], discountTotal: 900, metadata: address });
    const automaticSlice = await service.buildOrderSlice(TEST_ORG_ID, store.id, automatic);
    expect(automaticSlice).toMatchObject({ ok: true, value: { grandTotal: 24000, discount: { code: "DISCOUNT", amount: 900 } } });

    // D3: an order spanning two stores: one discount cannot be split honestly, so neither slice claims it.
    const split = await seedOrder({ lines: [{ entityId: product.entityId, totalPrice: 24900 }, { entityId: elsewhere.entityId, totalPrice: 1000 }], discountTotal: 2590, metadata: { ...address, promotionCode: "SAVE10" } });
    const splitSlice = await service.buildOrderSlice(TEST_ORG_ID, store.id, split);
    expect(splitSlice.ok && splitSlice.value.grandTotal).toBe(24900);
    expect(splitSlice.ok && "discount" in splitSlice.value).toBe(false);
  });

  it("sends the store the ORDER's shipping address, falling back to the saved default only when the order has none", async () => {
    const store = await connect("address");
    const product = await seedEntity(store.id, "address-product");
    await mapEntity(store.id, product.entityId, "address-external");
    const customerId = crypto.randomUUID();
    await built.db.insert(customers).values({
      id: customerId,
      organizationId: TEST_ORG_ID,
      userId: `customer-${customerId}`,
      email: "address@example.test",
      firstName: "Address",
      lastName: "Shopper",
    });
    await built.db.insert(customerAddresses).values([
      { customerId, type: "shipping", isDefault: true, firstName: "Address", lastName: "Shopper", line1: "1 Saved Default Road", city: "Colombo", country: "LK" },
      { customerId, type: "shipping", isDefault: false, firstName: "Address", lastName: "Shopper", line1: "2 Saved Other Lane", city: "Kandy", country: "LK" },
    ]);
    const addressOf = async (orderId: string) => {
      const slice = await service.buildOrderSlice(TEST_ORG_ID, store.id, orderId);
      return slice.ok ? slice.value.customer.shippingAddress : slice;
    };

    // A1: typed at checkout, different from every saved address.
    const typed = await seedOrder({ customerId, lines: [{ entityId: product.entityId }], metadata: { shippingAddress: { firstName: "Address", lastName: "Shopper", line1: "9 Typed At Checkout", city: "Galle", countryCode: "LK" } } });
    expect(await addressOf(typed)).toMatchObject({ line1: "9 Typed At Checkout", city: "Galle" });

    // A2: a NON-default saved address picked at checkout, carried on the order.
    const picked = await seedOrder({ customerId, lines: [{ entityId: product.entityId }], metadata: { shippingAddress: { firstName: "Address", lastName: "Shopper", line1: "2 Saved Other Lane", city: "Kandy", countryCode: "LK" } } });
    expect(await addressOf(picked)).toMatchObject({ line1: "2 Saved Other Lane", city: "Kandy" });

    // A3: no address on the order: the saved default is the fallback.
    const bare = await seedOrder({ customerId, lines: [{ entityId: product.entityId }] });
    expect(await addressOf(bare)).toMatchObject({ line1: "1 Saved Default Road", city: "Colombo" });

    // A4: guest checkout carries its address on guestCustomer.
    const guest = await seedOrder({ lines: [{ entityId: product.entityId }], metadata: { guestCustomer: { email: "g@example.test", name: "G", shippingAddress: { firstName: "Address", lastName: "Shopper", line1: "7 Guest Street", city: "Matara", countryCode: "LK" } } } });
    expect(await addressOf(guest)).toMatchObject({ line1: "7 Guest Street" });

    // A5: neither: a definitive refusal, never a push without an address.
    const nothing = await seedOrder({ lines: [{ entityId: product.entityId }], metadata: { customer: { email: "n@example.test", name: "N" } } });
    expect(await addressOf(nothing)).toMatchObject({ ok: false, code: "CUSTOMER_DATA_MISSING" });
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
        shippingAddress: { firstName: "Address", lastName: "Shopper", line1: "4 Job Road", city: "Colombo", countryCode: "LK" },
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
