import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@porulle/core";
import { createPluginTestApp, TEST_ORG_ID } from "@porulle/core/testing";
import { eq } from "@porulle/core/drizzle";
import { commerceJobs, sellableEntities } from "@porulle/core/schema";
import { channelConnectorPlugin, mockChannelConnector } from "../src/index.js";

/**
 * Charter non-negotiable 6: nothing is pushed to a merchant before verified
 * payment. The connector's push must fire when an order leaves
 * `pending_payment` for anything but `cancelled`, not when the row is created.
 *
 * Every negative row here is paired with the positive twin that proves it is
 * not passing against a connector that simply never pushes.
 */

const actor: Actor = {
  type: "user",
  userId: "push-on-payment-admin",
  email: "push-on-payment@test.local",
  name: "Push On Payment Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

type TestApp = Awaited<ReturnType<typeof createPluginTestApp>>;

async function connectStore(built: TestApp, storeName: string): Promise<string> {
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
  const payload = (await response.json()) as { data: { id: string } };
  return payload.data.id;
}

async function seedChannelEntity(
  built: TestApp,
  storeId: string,
  suffix: string,
): Promise<string> {
  const entityId = crypto.randomUUID();
  await built.db.insert(sellableEntities).values({
    id: entityId,
    organizationId: TEST_ORG_ID,
    sourceStoreId: storeId,
    type: "product",
    slug: `push-on-payment-${suffix}`,
    status: "active",
    isVisible: true,
  });
  return entityId;
}

async function createOrder(
  built: TestApp,
  entityId: string,
  status: "pending" | "pending_payment",
): Promise<string> {
  const result = await built.kernel.services.orders.create(
    {
      currency: "USD",
      subtotal: 1000,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: 1000,
      status,
      lineItems: [
        {
          entityId,
          entityType: "product",
          title: "Channel Product",
          quantity: 1,
          unitPrice: 1000,
          totalPrice: 1000,
        },
      ],
    },
    actor,
    undefined,
    { trustedPricing: true },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.id;
}

async function changeStatus(
  built: TestApp,
  orderId: string,
  newStatus: string,
): Promise<boolean> {
  const result = await built.kernel.services.orders.changeStatus(
    { orderId, newStatus },
    actor,
  );
  return result.ok;
}

/** Push jobs enqueued for one order, by the store each targets. */
async function pushedStoreIds(
  built: TestApp,
  orderId: string,
): Promise<string[]> {
  const jobs = await built.db
    .select()
    .from(commerceJobs)
    .where(eq(commerceJobs.taskSlug, "channel/push-order"));
  return jobs
    .filter((job) => (job.input as { orderId?: string }).orderId === orderId)
    .map((job) => (job.input as { storeId: string }).storeId)
    .sort();
}

describe("channel connector pushes on payment, not on creation", () => {
  const mock = mockChannelConnector({ catalog: [] });
  let built: TestApp;
  let storeId: string;

  beforeAll(async () => {
    built = await createPluginTestApp(
      channelConnectorPlugin({ connectors: [mock] }),
    );
    storeId = await connectStore(built, "pop-default");
  }, 30_000);

  it("R1+R2: an order created in pending_payment pushes nothing, and pushes exactly once when it is confirmed", async () => {
    const entityId = await seedChannelEntity(built, storeId, "r1r2");
    const orderId = await createOrder(built, entityId, "pending_payment");

    // R1 — the defect, dead. Unpaid: nothing reaches the merchant.
    expect(await pushedStoreIds(built, orderId)).toEqual([]);

    // R2 — the twin R1 needs. Without it R1 passes against a connector that
    // never pushes at all.
    expect(await changeStatus(built, orderId, "confirmed")).toBe(true);
    expect(await pushedStoreIds(built, orderId)).toEqual([storeId]);
  });

  it("R3: an order created in pending still pushes on creation, as today", async () => {
    const entityId = await seedChannelEntity(built, storeId, "r3");
    const orderId = await createOrder(built, entityId, "pending");

    // The no-payment-step consumer is unaffected. This is the row that catches
    // dropping `orders.afterCreate` when the status-change hook is added.
    expect(await pushedStoreIds(built, orderId)).toEqual([storeId]);
  });

  it("R4: a pending order that is later confirmed is not pushed a second time", async () => {
    const entityId = await seedChannelEntity(built, storeId, "r4");
    const orderId = await createOrder(built, entityId, "pending");
    expect(await pushedStoreIds(built, orderId)).toEqual([storeId]);

    // `confirmed` is not an initial state — core's create() refuses any status
    // outside ["pending", "pending_payment"] — so the card's "created directly
    // in confirmed" is unreachable. The real hazard it was reaching for is a
    // double push, and this asserts it directly: the transition did not come
    // from `pending_payment`, so the status-change hook must not fire.
    expect(await changeStatus(built, orderId, "confirmed")).toBe(true);
    expect(await pushedStoreIds(built, orderId)).toEqual([storeId]);
  });

  it("R5: pending_payment -> cancelled pushes nothing", async () => {
    const entityId = await seedChannelEntity(built, storeId, "r5");
    const orderId = await createOrder(built, entityId, "pending_payment");
    expect(await changeStatus(built, orderId, "cancelled")).toBe(true);
    expect(await pushedStoreIds(built, orderId)).toEqual([]);
  });

  it("R8: a replayed confirm does not push twice", async () => {
    const entityId = await seedChannelEntity(built, storeId, "r8");
    const orderId = await createOrder(built, entityId, "pending_payment");
    expect(await changeStatus(built, orderId, "confirmed")).toBe(true);

    // The replay is refused by the state machine (confirmed -> confirmed is not
    // a transition), and no second job appears. Both halves are asserted: a row
    // checking only the job count would pass if the replay silently succeeded.
    expect(await changeStatus(built, orderId, "confirmed")).toBe(false);
    expect(await pushedStoreIds(built, orderId)).toEqual([storeId]);
  });

  it("R2b: one job per source store, for an order spanning two stores", async () => {
    const secondStoreId = await connectStore(built, "pop-second");
    const first = await seedChannelEntity(built, storeId, "r2b-first");
    const second = await seedChannelEntity(built, secondStoreId, "r2b-second");
    const result = await built.kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 2000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 2000,
        status: "pending_payment",
        lineItems: [
          {
            entityId: first,
            entityType: "product",
            title: "A",
            quantity: 1,
            unitPrice: 1000,
            totalPrice: 1000,
          },
          {
            entityId: second,
            entityType: "product",
            title: "B",
            quantity: 1,
            unitPrice: 1000,
            totalPrice: 1000,
          },
        ],
      },
      actor,
      undefined,
      { trustedPricing: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const orderId = result.value.id;

    expect(await pushedStoreIds(built, orderId)).toEqual([]);
    expect(await changeStatus(built, orderId, "confirmed")).toBe(true);
    expect(await pushedStoreIds(built, orderId)).toEqual(
      [storeId, secondStoreId].sort(),
    );
  });
});

describe('channel connector pushOrderOn: "create" keeps the old trigger', () => {
  const mock = mockChannelConnector({ catalog: [] });
  let built: TestApp;
  let storeId: string;

  beforeAll(async () => {
    built = await createPluginTestApp(
      channelConnectorPlugin({ connectors: [mock], pushOrderOn: "create" }),
    );
    storeId = await connectStore(built, "pop-create");
  }, 30_000);

  it("R6: an order created in pending_payment pushes immediately, exactly as before the change", async () => {
    const entityId = await seedChannelEntity(built, storeId, "r6");
    const orderId = await createOrder(built, entityId, "pending_payment");

    // The opt-out really opts out, so a consumer who wants the old trigger is
    // not silently migrated.
    expect(await pushedStoreIds(built, orderId)).toEqual([storeId]);
  });
});

describe("channel connector pushOrderOn: false registers no push at all", () => {
  const mock = mockChannelConnector({ catalog: [] });
  let built: TestApp;
  let storeId: string;

  beforeAll(async () => {
    built = await createPluginTestApp(
      channelConnectorPlugin({ connectors: [mock], pushOrderOn: false }),
    );
    storeId = await connectStore(built, "pop-off");
  }, 30_000);

  it("R7: no push on creation and none on transition", async () => {
    const pendingEntity = await seedChannelEntity(built, storeId, "r7-pending");
    const pendingOrder = await createOrder(built, pendingEntity, "pending");
    expect(await pushedStoreIds(built, pendingOrder)).toEqual([]);

    const gatewayEntity = await seedChannelEntity(built, storeId, "r7-gateway");
    const gatewayOrder = await createOrder(
      built,
      gatewayEntity,
      "pending_payment",
    );
    expect(await pushedStoreIds(built, gatewayOrder)).toEqual([]);
    expect(await changeStatus(built, gatewayOrder, "confirmed")).toBe(true);
    expect(await pushedStoreIds(built, gatewayOrder)).toEqual([]);
  });
});
