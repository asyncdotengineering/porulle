/**
 * An order cancelled while it is being sent to a store must not stay at the store.
 *
 * The push job checks the order is open, then pushes, and the push takes several store calls. A
 * shopper's cancel landing in that window used to find no store order to cancel (it had no remote id
 * yet), so the store received, and could ship, an order the shopper had been refunded for.
 *
 * Every way the two can interleave, each held at the exact point with a latch:
 *   E1  the cancel commits while the push is in flight;
 *   E2  the push finishes between the cancel's store step and its commit;
 *   E3  the cancel's store step runs before the push claims the export, and commits during the push;
 *   E4  the cancel commits after the job's check but before the export is claimed;
 *   E5  as E1, at a store that cannot cancel: the export is left for an operator, not called delivered.
 * Twin: an order left alone is pushed and confirmed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Ok, runPendingJobs, type ChannelCancelOrderInput } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { sellableEntities, variants } from "@porulle/core/schema";
import { createPluginTestApp, createTestActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, channelOrderExports } from "../src/schema.js";

const actor = createTestActor({
  userId: "export-after-cancel-admin",
  email: "export-after-cancel@test.local",
  name: "Export After Cancel Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
});

interface Latch { wait: Promise<void>; open: () => void }
function latch(): Latch {
  let open = () => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

/** A push held at the store: `started` opens when the store has it, `release` lets it answer. */
const heldPushes = new Map<string, { started: Latch; release: Latch }>();
const pushedOrderIds: string[] = [];
const cancelCalls: Array<{ remoteId: string; input: ChannelCancelOrderInput }> = [];

function holdingPushes(base: ReturnType<typeof mockChannelConnector>) {
  return {
    async pushOrder(...args: Parameters<typeof base.pushOrder>) {
      pushedOrderIds.push(args[1].orderId);
      const held = heldPushes.get(args[1].orderId);
      if (held) {
        held.started.open();
        await held.release.wait;
      }
      return base.pushOrder(...args);
    },
  };
}

const cancellingBase = mockChannelConnector({ catalog: [] });
const cancelling = {
  ...cancellingBase,
  ...holdingPushes(cancellingBase),
  async cancelOrder(_store: unknown, remoteId: string, input: ChannelCancelOrderInput) {
    cancelCalls.push({ remoteId, input });
    return Ok(undefined);
  },
};
// A store with no way to cancel an order it has received.
const noCancelBase = mockChannelConnector({ catalog: [] });
const noCancel = { ...noCancelBase, providerId: "mock-no-cancel", ...holdingPushes(noCancelBase) };

describe("an order cancelled while it is being sent to a store", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  const stores = { cancelling: { storeId: "", entityId: "", variantId: "" }, noCancel: { storeId: "", entityId: "", variantId: "" } };
  /** Armed by a test: the cancel stops after the store step and before the status commits. */
  let commitGate: { reached: Latch; release: Latch } | null = null;

  beforeAll(async () => {
    const connectors = [cancelling, noCancel];
    built = await createPluginTestApp(channelConnectorPlugin({ connectors }));
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors });
    for (const [key, provider] of [["cancelling", "mock"], ["noCancel", "mock-no-cancel"]] as const) {
      const response = await built.app.request("http://localhost/api/channels/stores", {
        method: "POST",
        headers: jsonHeaders(actor),
        body: JSON.stringify({ provider, credentials: { accessToken: key }, storeDomain: `${key}.mock.channel.test`, webhookSecret: "secret" }),
      });
      expect(response.status).toBe(201);
      const storeId = ((await response.json()) as { data: { id: string } }).data.id;
      const entityId = crypto.randomUUID();
      const variantId = crypto.randomUUID();
      await built.db.insert(sellableEntities).values({ id: entityId, organizationId: TEST_ORG_ID, sourceStoreId: storeId, type: "product", slug: `after-cancel-${key}`, status: "active" });
      await built.db.insert(variants).values({ id: variantId, organizationId: TEST_ORG_ID, entityId, sku: `AFTER-CANCEL-${key}`, status: "active", sortOrder: 0 });
      await built.db.insert(channelEntityMap).values({ organizationId: TEST_ORG_ID, storeId, kind: "variant", externalId: `${key}-801`, entityId, variantId, syncHash: "fixture" });
      stores[key] = { storeId, entityId, variantId };
    }
    // Runs after the connector's own cancel hook, i.e. between its store step and core's status commit.
    built.kernel.hooks.append("orders.beforeStatusChange", async (args: { data: unknown }) => {
      const gate = commitGate;
      if (gate) {
        commitGate = null;
        gate.reached.open();
        await gate.release.wait;
      }
      return args.data;
    });
  }, 60_000);

  /** A paid order: confirming it enqueues its push, which runs when the test runs the jobs. */
  async function paidOrder(store: keyof typeof stores): Promise<string> {
    const { entityId, variantId } = stores[store];
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
    return created.value.id;
  }

  function holdPush(orderId: string) {
    const held = { started: latch(), release: latch() };
    heldPushes.set(orderId, held);
    return held;
  }
  function holdCancelCommit() {
    const gate = { reached: latch(), release: latch() };
    commitGate = gate;
    return gate;
  }
  async function cancel(orderId: string): Promise<boolean> {
    const result = await built.kernel.services.orders.changeStatus({ orderId, newStatus: "cancelled", reason: "shopper_cancelled" }, actor);
    return result.ok;
  }
  const exportOf = async (orderId: string) =>
    (await built.db.select().from(channelOrderExports).where(eq(channelOrderExports.orderId, orderId)))[0];
  const runJobs = () => runPendingJobs({
    db: built.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
    tasks: new Map((built.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
    logger: built.kernel.logger,
    services: built.kernel.services,
    limit: 100,
  });
  const cancelledAtStore = (orderId: string) => cancelCalls.some((call) => call.remoteId === `mock-order-${orderId}`);

  it("twin: an order left alone is pushed, confirmed, and never cancelled at the store", async () => {
    const orderId = await paidOrder("cancelling");
    await runJobs();
    expect(await exportOf(orderId)).toMatchObject({ state: "confirmed", remoteOrderId: `mock-order-${orderId}` });
    expect(cancelledAtStore(orderId)).toBe(false);
  });

  it("E1: a cancel that commits while the push is in flight cancels the store order the push made", async () => {
    const orderId = await paidOrder("cancelling");
    const push = holdPush(orderId);
    const jobs = runJobs();
    await push.started.wait;
    expect(await cancel(orderId)).toBe(true);
    push.release.open();
    await jobs;
    expect(cancelledAtStore(orderId)).toBe(true);
    expect(await exportOf(orderId)).toMatchObject({ state: "abandoned", remoteOrderId: `mock-order-${orderId}` });
  });

  it("E2: a push that lands between the cancel's store step and its commit is still taken back", async () => {
    const orderId = await paidOrder("cancelling");
    const push = holdPush(orderId);
    const jobs = runJobs();
    await push.started.wait;
    const gate = holdCancelCommit();
    const cancelled = cancel(orderId);
    await gate.reached.wait;
    push.release.open();
    await jobs;
    gate.release.open();
    expect(await cancelled).toBe(true);
    expect(cancelledAtStore(orderId)).toBe(true);
    expect(await exportOf(orderId)).toMatchObject({ state: "abandoned", remoteOrderId: `mock-order-${orderId}` });
  });

  it("E3: a cancel whose store step ran before the push claimed the export, committing mid-push, is still seen", async () => {
    const orderId = await paidOrder("cancelling");
    const gate = holdCancelCommit();
    const cancelled = cancel(orderId);
    await gate.reached.wait;
    const push = holdPush(orderId);
    const jobs = runJobs();
    await push.started.wait;
    gate.release.open();
    expect(await cancelled).toBe(true);
    push.release.open();
    await jobs;
    expect(cancelledAtStore(orderId)).toBe(true);
    expect(await exportOf(orderId)).toMatchObject({ state: "abandoned", remoteOrderId: `mock-order-${orderId}` });
  });

  it("E4: a cancel committed after the job's check and before the claim stops the push before the store is called", async () => {
    const orderId = await paidOrder("cancelling");
    const { storeId } = stores.cancelling;
    const created = await service.createExport(TEST_ORG_ID, storeId, orderId);
    expect(created.ok).toBe(true);
    const slice = await service.buildOrderSlice(TEST_ORG_ID, storeId, orderId);
    if (!slice.ok) throw new Error(slice.error);
    expect(await cancel(orderId)).toBe(true);
    const result = await service.exportOrder(TEST_ORG_ID, storeId, slice.value, actor);
    expect(pushedOrderIds).not.toContain(orderId);
    expect(result.ok && result.value.state).toBe("abandoned");
    expect((await exportOf(orderId))?.remoteOrderId).toBeNull();
  });

  it("E5: at a store that cannot cancel, the export is left failed for an operator with the store order named", async () => {
    const orderId = await paidOrder("noCancel");
    const push = holdPush(orderId);
    const jobs = runJobs();
    await push.started.wait;
    expect(await cancel(orderId)).toBe(true);
    push.release.open();
    await jobs;
    const row = await exportOf(orderId);
    expect(row).toMatchObject({ state: "failed", failureKind: "definitive", remoteOrderId: `mock-order-${orderId}` });
    expect(row?.lastError).toContain(`mock-order-${orderId}`);
    const failed = await service.listFailedExports(TEST_ORG_ID);
    expect(failed.ok && failed.value.map((item) => item.orderId)).toContain(orderId);
  });

  /** The whole push (claim, store call, record, confirm) runs after the cancel's store step and before its commit. */
  async function pushInsideCancelWindow(store: keyof typeof stores): Promise<string> {
    const orderId = await paidOrder(store);
    const gate = holdCancelCommit();
    const cancelled = cancel(orderId);
    await gate.reached.wait;
    await runJobs();
    expect(await exportOf(orderId)).toMatchObject({ state: "confirmed", remoteOrderId: `mock-order-${orderId}` });
    gate.release.open();
    expect(await cancelled).toBe(true);
    return orderId;
  }

  it("E6: a push that claims and records entirely inside the cancel's window is cancelled at the store after the commit", async () => {
    const orderId = await pushInsideCancelWindow("cancelling");
    expect(cancelCalls.filter((call) => call.remoteId === `mock-order-${orderId}`)).toHaveLength(1);
    expect(await exportOf(orderId)).toMatchObject({ state: "abandoned" });

    // At a store that cannot cancel, the export is left failed for an operator rather than confirmed.
    const stranded = await pushInsideCancelWindow("noCancel");
    const row = await exportOf(stranded);
    expect(row).toMatchObject({ state: "failed", failureKind: "definitive" });
    expect(row?.lastError).toContain(`mock-order-${stranded}`);
  });

  it("E7: at a store that cannot cancel, a push that finds the order closed when it records is left failed", async () => {
    const orderId = await paidOrder("noCancel");
    const gate = holdCancelCommit();
    const cancelled = cancel(orderId);
    await gate.reached.wait;
    const push = holdPush(orderId);
    const jobs = runJobs();
    await push.started.wait;
    gate.release.open();
    expect(await cancelled).toBe(true);
    push.release.open();
    await jobs;
    const row = await exportOf(orderId);
    expect(row).toMatchObject({ state: "failed", failureKind: "definitive", remoteOrderId: `mock-order-${orderId}` });
    expect(row?.lastError).toContain(`mock-order-${orderId}`);
  });
});
