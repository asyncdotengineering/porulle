import { beforeAll, describe, expect, it } from "vitest";
import { createSystemActor, type Actor, type ChannelCatalogItem, type PluginTxFn } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor: Actor = testAdminActor;

describe("channel connector catalog metadata convergence", () => {
  const remoteItem: ChannelCatalogItem = {
    externalId: "metadata-product",
    slug: "metadata-product",
    title: "Remote title",
    description: "Remote description",
    metadata: {
      remoteKey: "remote-v1",
      removedUpstreamKey: "keep-me",
    },
    variants: [{ externalId: "metadata-variant", sku: "METADATA-SKU" }],
  };
  const mock = mockChannelConnector({ catalog: [remoteItem] });
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let storeId: string;
  let entityId: string;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock] }));
    service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [mock] },
      built.kernel.database.transaction as PluginTxFn,
    );
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({
        provider: "mock",
        credentials: {},
        storeDomain: "metadata.test",
        webhookSecret: "metadata-secret",
      }),
    });
    expect(response.status).toBe(201);
    storeId = (await response.json()).data.id as string;

    const imported = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(imported).toEqual({ ok: true, value: { imported: 1, cursor: null } });

    const [entity] = await built.db
      .select({ id: sellableEntities.id })
      .from(sellableEntities)
      .where(and(
        eq(sellableEntities.organizationId, TEST_ORG_ID),
        eq(sellableEntities.sourceStoreId, storeId),
        eq(sellableEntities.slug, remoteItem.slug),
      ));
    entityId = entity!.id;
  }, 30_000);

  it("preserves stored keys, updates remote keys, and keeps keys absent upstream", async () => {
    const patched = await built.kernel.services.catalog.update(
      entityId,
      { metadata: { platformKey: "platform-value" } },
      actor,
    );
    expect(patched.ok).toBe(true);

    remoteItem.title = "Updated remote title";
    remoteItem.metadata = { remoteKey: "remote-v2", removedUpstreamKey: "keep-me" };
    const converged = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(converged).toEqual({ ok: true, value: { imported: 0, cursor: null } });

    const [updated] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(updated?.metadata).toEqual({
      platformKey: "platform-value",
      remoteKey: "remote-v2",
      removedUpstreamKey: "keep-me",
    });

    remoteItem.metadata = { remoteKey: "remote-v3" };
    const absentUpstreamKey = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(absentUpstreamKey).toEqual({ ok: true, value: { imported: 0, cursor: null } });

    const [updatedWithoutRemoteKey] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(updatedWithoutRemoteKey?.metadata).toEqual({
      platformKey: "platform-value",
      remoteKey: "remote-v3",
      removedUpstreamKey: "keep-me",
    });

    const archived = await built.kernel.services.catalog.archive(entityId, actor);
    expect(archived.ok).toBe(true);
    const reimported = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(reimported).toEqual({ ok: true, value: { imported: 0, cursor: null } });

    const [reactivated] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(reactivated?.status).toBe("active");
    expect(reactivated?.metadata).toEqual(updatedWithoutRemoteKey?.metadata);
  });

  it("preserves stored keys when a product webhook updates remote metadata", async () => {
    const patched = await built.kernel.services.catalog.update(
      entityId,
      { metadata: { webhookPlatformKey: "webhook-platform-value" } },
      actor,
    );
    expect(patched.ok).toBe(true);

    const handled = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "metadata-webhook-event",
      type: "products/update",
      data: {
        id: remoteItem.externalId,
        title: "Webhook remote title",
        description: "Webhook remote description",
        metadata: { webhookRemoteKey: "webhook-remote-value" },
        variants: [],
      },
    });
    expect(handled).toEqual({ ok: true, value: { processed: true } });

    const [updated] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(updated?.metadata).toEqual({
      webhookPlatformKey: "webhook-platform-value",
      webhookRemoteKey: "webhook-remote-value",
    });
  });
});
