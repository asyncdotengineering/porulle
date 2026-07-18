import { beforeAll, describe, expect, it } from "vitest";
import { createSystemActor, type Actor, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { type PluginTxFn } from "@porulle/core";
import { commerceJobs, sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, connectedStores } from "../src/schema.js";

const actor: Actor = {
  type: "user",
  userId: "c74-operator",
  email: "c74@test.local",
  name: "c74 Operator",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

const item = (externalId: string, title: string): ChannelCatalogItem => ({
  externalId,
  slug: externalId,
  title,
  variants: [{ externalId: `${externalId}-variant`, sku: `${externalId}-sku` }],
});

describe("channel connector c74 reconciliation", () => {
  const mockOptions: { catalog: ChannelCatalogItem[]; inventory: { externalId: string; available: number }[] } = {
    catalog: [item("remote-kept", "Kept"), item("remote-removed", "Removed")],
    inventory: [{ externalId: "remote-kept-variant", available: 4 }, { externalId: "remote-removed-variant", available: 2 }],
  };
  const mock = mockChannelConnector(mockOptions);
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let storeId: string;
  let removedEntityId: string;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock], driftAlertThreshold: 0 }));
    service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [mock], driftAlertThreshold: 0 }, built.kernel.database.transaction as PluginTxFn);
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": JSON.stringify(actor) },
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "c74.test", webhookSecret: "c74-secret" }),
    });
    storeId = (await response.json()).data.id;
    const imported = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(imported.ok).toBe(true);
    const [removed] = await built.db.select({ id: sellableEntities.id }).from(sellableEntities).where(and(
      eq(sellableEntities.organizationId, TEST_ORG_ID),
      eq(sellableEntities.slug, "remote-removed"),
    ));
    removedEntityId = removed!.id;
  }, 30_000);

  it("imports, converges, archives, level-sets inventory, and persists drift", async () => {
    mockOptions.catalog = [item("remote-kept", "Kept changed"), item("remote-added", "Added")];
    mockOptions.inventory = [{ externalId: "remote-kept-variant", available: 9 }];
    const result = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(result).toEqual({ ok: true, value: { imported: 1, converged: 1, archived: 1, inventoryUpdated: 1, driftAlert: true } });

    const [changed] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.slug, "remote-kept"));
    expect(changed?.metadata).toMatchObject({ title: "Kept changed" });
    const [archived] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, removedEntityId));
    expect(archived?.status).toBe("archived");
    expect((await built.db.select().from(channelEntityMap).where(eq(channelEntityMap.entityId, removedEntityId)))).toHaveLength(2);
    const status = await built.app.request(`http://localhost/api/channels/stores/${storeId}/reconcile-status`, {
      headers: { "x-test-actor": JSON.stringify(actor) },
    });
    expect(status.status).toBe(200);
    expect((await status.json()).data).toMatchObject({ report: { imported: 1, converged: 1, archived: 1, inventoryUpdated: 1, driftAlert: true }, driftAlert: true });
  });

  it("is idempotent and reactivates the original mapped entity", async () => {
    const second = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(second).toEqual({ ok: true, value: { imported: 0, converged: 0, archived: 0, inventoryUpdated: 0, driftAlert: false } });
    mockOptions.catalog = [item("remote-kept", "Kept changed"), item("remote-added", "Added"), item("remote-removed", "Removed")];
    mockOptions.inventory.push({ externalId: "remote-removed-variant", available: 2 });
    const reappeared = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(reappeared.ok && reappeared.value.converged).toBe(1);
    const [entity] = await built.db.select({ id: sellableEntities.id, status: sellableEntities.status }).from(sellableEntities).where(eq(sellableEntities.id, removedEntityId));
    expect(entity).toEqual({ id: removedEntityId, status: "active" });
    expect((await built.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.entityId, removedEntityId), eq(channelEntityMap.kind, "entity"))))).toHaveLength(1);
  });

  it("enqueues one jittered reconcile per connected store", async () => {
    const other = await built.db.insert(connectedStores).values({ organizationId: TEST_ORG_ID, provider: "mock", credentials: {}, storeDomain: "other.c74.test" }).returning({ id: connectedStores.id });
    const sweep = (built.kernel.config.jobs?.tasks ?? []).find((job) => job.slug === "channel/reconcile-sweep")!;
    const context = { db: built.db, services: built.kernel.services, logger: built.kernel.logger } as unknown as Parameters<typeof sweep.handler>[0]["ctx"];
    await sweep.handler({ input: { orgId: TEST_ORG_ID }, ctx: context });
    const rows = await built.db.select().from(commerceJobs).where(and(eq(commerceJobs.organizationId, TEST_ORG_ID), eq(commerceJobs.taskSlug, "channel/reconcile")));
    expect(rows.filter((row) => row.input && [storeId, other[0]!.id].includes(String((row.input as Record<string, unknown>).storeId)))).toHaveLength(2);
    expect(rows.every((row) => row.concurrencyKey === String((row.input as Record<string, unknown>).storeId))).toBe(true);
  });
});
