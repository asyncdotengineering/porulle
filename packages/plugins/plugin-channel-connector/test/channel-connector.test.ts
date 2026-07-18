import { beforeAll, describe, expect, it } from "vitest";
import {
  createSystemActor,
  type Actor,
  type ChannelOrderSlice,
  type PluginTxFn,
} from "@porulle/core";
import {
  createPluginTestApp,
  jsonHeaders,
  TEST_ORG_ID,
  testNoPermActor,
} from "@porulle/core/testing";
import { organization } from "@porulle/core/auth-schema";
import { sellableEntities, variants } from "@porulle/core/schema";
import { and, eq, sql } from "@porulle/core/drizzle";
import {
  channelConnectorPlugin,
  ChannelConnectorService,
  mockChannelConnector,
} from "../src/index.js";
import {
  channelEntityMap,
  channelExportEvents,
  channelOrderExports,
  connectedStores,
} from "../src/schema.js";

const OTHER_ORG = "org_channel_connector_other";

function channelActor(organizationId: string): Actor {
  return {
    type: "user",
    userId: `channel-admin-${organizationId}`,
    email: `channel-${organizationId}@test.local`,
    name: "Channel Admin",
    vendorId: null,
    organizationId,
    role: "admin",
    permissions: ["channels:read", "channels:manage"],
  };
}

describe("plugin-channel-connector foundations", () => {
  const mock = mockChannelConnector({
    catalog: [
      {
        externalId: "mock-product-1",
        slug: "mock-channel-product",
        title: "Mock Channel Product",
        description: "Imported through the mock connector.",
        variants: [
          { externalId: "mock-variant-1", sku: "MOCK-SKU-1" },
        ],
      },
    ],
    inventory: [{ externalId: "mock-variant-1", available: 12 }],
  });
  const actorA = channelActor(TEST_ORG_ID);
  const actorB = channelActor(OTHER_ORG);
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock] }));
    await built.db.insert(organization).values({
      id: OTHER_ORG,
      name: "Channel Connector Other",
      slug: "channel-connector-other",
      createdAt: new Date(),
    });
    service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [mock] },
      built.kernel.database.transaction as PluginTxFn,
    );
  }, 30_000);

  async function connect(actor: Actor = actorA) {
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({
        provider: "mock",
        credentials: { accessToken: "secret-token" },
        storeDomain: `${actor.organizationId}.mock.channel.test`,
        webhookSecret: "secret-webhook",
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).data as {
      id: string;
      credentials: string;
      webhookSecret: string;
      status: string;
    };
  }

  it("boots standalone, rejects unknown providers, and rejects duplicate provider registrations", async () => {
    const unknown = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actorA),
      body: JSON.stringify({
        provider: "missing",
        credentials: {},
        storeDomain: "missing.example.test",
      }),
    });
    expect(unknown.status).toBe(404);

    expect(() => new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [mock, mock] },
      built.kernel.database.transaction as PluginTxFn,
    )).toThrow("Duplicate channel connector providerId");
  });

  it("permission-gates store routes and redacts secrets on every public read", async () => {
    const forbidden = await built.app.request("http://localhost/api/channels/stores", {
      method: "GET",
      headers: jsonHeaders(testNoPermActor),
    });
    expect(forbidden.status).toBe(403);

    const store = await connect();
    expect(store.credentials).toBe("[REDACTED]");
    expect(store.webhookSecret).toBe("[REDACTED]");

    const detail = await built.app.request(`http://localhost/api/channels/stores/${store.id}`, {
      method: "GET",
      headers: jsonHeaders(actorA),
    });
    expect(detail.status).toBe(200);
    const read = (await detail.json()).data;
    expect(read.credentials).toBe("[REDACTED]");
    expect(read.webhookSecret).toBe("[REDACTED]");

    const list = await built.app.request("http://localhost/api/channels/stores", {
      method: "GET",
      headers: jsonHeaders(actorA),
    });
    const stores = (await list.json()).data as Array<Record<string, unknown>>;
    expect(stores.every((item) => item.credentials === "[REDACTED]")).toBe(true);
    expect(stores.every((item) => item.webhookSecret === "[REDACTED]")).toBe(true);
  });

  it("keeps connected stores and exports invisible across organizations", async () => {
    const store = await connect();
    const invisible = await built.app.request(`http://localhost/api/channels/stores/${store.id}`, {
      method: "GET",
      headers: jsonHeaders(actorB),
    });
    expect(invisible.status).toBe(404);

    const otherList = await built.app.request("http://localhost/api/channels/stores", {
      method: "GET",
      headers: jsonHeaders(actorB),
    });
    expect(otherList.status).toBe(200);
    expect((await otherList.json()).data).toEqual([]);

    const createdExport = await service.createExport(TEST_ORG_ID, store.id, crypto.randomUUID());
    expect(createdExport.ok).toBe(true);
    if (!createdExport.ok) return;
    const hiddenExport = await service.getExport(OTHER_ORG, createdExport.value.id);
    expect(hiddenExport.ok).toBe(false);
  });

  it("disconnects a store and removes persisted credentials", async () => {
    const store = await connect();
    const response = await built.app.request(
      `http://localhost/api/channels/stores/${store.id}/disconnect`,
      { method: "POST", headers: jsonHeaders(actorA) },
    );
    expect(response.status).toBe(201);
    const disconnected = (await response.json()).data;
    expect(disconnected.status).toBe("disconnected");
    expect(disconnected.credentials).toBe("[REDACTED]");
    expect(disconnected.webhookSecret).toBe("[REDACTED]");

    const rows = await built.db
      .select()
      .from(connectedStores)
      .where(eq(connectedStores.id, store.id));
    expect(rows[0]?.credentials).toEqual({});
    expect(rows[0]?.webhookSecret).toBeNull();
  });

  it("enforces export transitions, audits each transition, and exposes failed retries", async () => {
    const store = await connect();
    const created = await service.createExport(TEST_ORG_ID, store.id, crypto.randomUUID());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const illegal = await service.transitionExport(
      TEST_ORG_ID,
      created.value.id,
      "confirmed",
      actorA.userId,
    );
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.code).toBe("INVALID_TRANSITION");

    expect((await service.transitionExport(
      TEST_ORG_ID,
      created.value.id,
      "exported",
      actorA.userId,
    )).ok).toBe(true);
    expect((await service.transitionExport(
      TEST_ORG_ID,
      created.value.id,
      "failed",
      actorA.userId,
      "remote timeout",
    )).ok).toBe(true);

    const failed = await built.app.request("http://localhost/api/channels/exports/failed", {
      method: "GET",
      headers: jsonHeaders(actorA),
    });
    expect(failed.status).toBe(200);
    expect(((await failed.json()).data as Array<{ id: string }>).some((item) => item.id === created.value.id)).toBe(true);

    const retry = await built.app.request(
      `http://localhost/api/channels/exports/${created.value.id}/retry`,
      { method: "POST", headers: jsonHeaders(actorA) },
    );
    expect(retry.status).toBe(201);
    expect((await retry.json()).data.state).toBe("exported");

    const abandoned = await service.abandonExport(
      TEST_ORG_ID,
      created.value.id,
      actorA.userId,
      "operator stop",
    );
    expect(abandoned.ok && abandoned.value.state).toBe("abandoned");
    const terminal = await service.transitionExport(
      TEST_ORG_ID,
      created.value.id,
      "exported",
      actorA.userId,
    );
    expect(terminal.ok).toBe(false);

    const events = await built.db
      .select()
      .from(channelExportEvents)
      .where(and(
        eq(channelExportEvents.organizationId, TEST_ORG_ID),
        eq(channelExportEvents.exportId, created.value.id),
      ));
    expect(events.map((event) => [event.fromState, event.toState])).toEqual([
      ["pending", "exported"],
      ["exported", "failed"],
      ["failed", "exported"],
      ["exported", "abandoned"],
    ]);
  });

  it("runs the mock connector end to end: connect, import, map, export, and confirm", async () => {
    const store = await connect();
    const systemActor = createSystemActor(TEST_ORG_ID);

    const imported = await service.importCatalog(TEST_ORG_ID, store.id, systemActor);
    expect(imported).toEqual({
      ok: true,
      value: { imported: 1, cursor: null },
    });
    const replay = await service.importCatalog(TEST_ORG_ID, store.id, systemActor);
    expect(replay).toEqual({
      ok: true,
      value: { imported: 0, cursor: null },
    });

    const entityRows = await built.db
      .select()
      .from(sellableEntities)
      .where(and(
        eq(sellableEntities.organizationId, TEST_ORG_ID),
        eq(sellableEntities.sourceStoreId, store.id),
      ));
    expect(entityRows).toHaveLength(1);
    const variantRows = await built.db
      .select()
      .from(variants)
      .where(eq(variants.entityId, entityRows[0]!.id));
    expect(variantRows).toHaveLength(1);
    expect(variantRows[0]).toMatchObject({
      organizationId: TEST_ORG_ID,
      sourceStoreId: store.id,
      sku: "MOCK-SKU-1",
    });

    const mappings = await built.db
      .select()
      .from(channelEntityMap)
      .where(and(
        eq(channelEntityMap.organizationId, TEST_ORG_ID),
        eq(channelEntityMap.storeId, store.id),
      ));
    expect(mappings).toHaveLength(2);
    expect(new Set(mappings.map((entry) => entry.kind))).toEqual(new Set(["entity", "variant"]));

    const slice: ChannelOrderSlice = {
      orderId: crypto.randomUUID(),
      currency: "USD",
      grandTotal: 2500,
      lines: [{
        externalVariantId: "mock-variant-1",
        sku: "MOCK-SKU-1",
        title: "Mock Channel Product",
        quantity: 1,
        unitPrice: 2500,
        totalPrice: 2500,
      }],
      customer: {
        name: "Priya Shopper",
        email: "priya@example.test",
        shippingAddress: { city: "Colombo", country: "LK" },
      },
    };
    const exported = await service.exportOrder(TEST_ORG_ID, store.id, slice, systemActor);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value).toMatchObject({
      state: "confirmed",
      attempts: 1,
    });
    expect(exported.value.remoteOrderId).toMatch(/^mock-order-/);

    const persisted = await built.db
      .select()
      .from(channelOrderExports)
      .where(eq(channelOrderExports.id, exported.value.id));
    expect(persisted[0]).toMatchObject({
      state: "confirmed",
      remoteOrderId: exported.value.remoteOrderId,
    });
    const events = await built.db
      .select()
      .from(channelExportEvents)
      .where(eq(channelExportEvents.exportId, exported.value.id));
    expect(events.map((event) => [event.fromState, event.toState])).toEqual([
      ["pending", "exported"],
      ["exported", "confirmed"],
    ]);
  });

  it("enqueues import on connect and level-sets mapped external inventory", async () => {
    const store = await connect();
    const queuedRaw = await built.db.execute(sql`
      SELECT organization_id, concurrency_key FROM commerce_jobs WHERE task_slug = 'channel/import-catalog'
    `);
    const queued = Array.isArray(queuedRaw)
      ? queuedRaw as Array<{ organization_id: string; concurrency_key: string | null }>
      : ((queuedRaw as { rows?: Array<{ organization_id: string; concurrency_key: string | null }> }).rows ?? []);
    expect(queued.some((job) => job.organization_id === TEST_ORG_ID && job.concurrency_key === store.id)).toBe(true);

    const mapped = await built.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.organizationId, TEST_ORG_ID),
      eq(channelEntityMap.kind, "variant"),
    ));
    const synced = await service.syncInventory(TEST_ORG_ID, mapped[0]!.storeId, createSystemActor(TEST_ORG_ID));
    expect(synced).toEqual({ ok: true, value: { synced: 1 } });
    const levelsRaw = await built.db.execute(sql`
      SELECT quantity_on_hand FROM inventory_levels WHERE organization_id = ${TEST_ORG_ID}
    `);
    const levels = Array.isArray(levelsRaw)
      ? levelsRaw as Array<{ quantity_on_hand: number }>
      : ((levelsRaw as { rows?: Array<{ quantity_on_hand: number }> }).rows ?? []);
    expect(levels.some((level) => level.quantity_on_hand === 12)).toBe(true);
  });
});
