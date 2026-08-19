import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type PluginTxFn } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { catalogFieldOwnership, entityMedia, mediaAssets, sellableAttributes, sellableEntities, sellableEntityRevisions } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, connectedStores } from "../src/schema.js";

function itemHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function createScenario(item: ChannelCatalogItem) {
  const connector = mockChannelConnector({ catalog: [item] });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const service = new ChannelConnectorService(
    built.db,
    built.kernel.services,
    { connectors: [connector] },
    built.kernel.database.transaction as PluginTxFn,
  );
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: `${item.externalId}.test` }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const imported = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
  expect(imported).toMatchObject({ ok: true, value: { imported: 1 } });
  const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.slug, item.slug));
  expect(entity).toBeDefined();
  return { built, service, storeId, entityId: entity!.id };
}

describe("channel connector field ownership convergence", () => {
  it("skips platform-owned fields, preserves other columns, and converges them after ownership moves to the store", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-platform",
      slug: "owned-product-platform",
      title: "Owned Product",
      attributes: [{ locale: "en", title: "Owned Product", description: "Original description" }],
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    const platform = await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "platform", testAdminActor);
    expect(platform).toEqual({ ok: true, value: undefined });

    item.attributes = [{ locale: "en", title: "Remote Platform Change", description: "Remote description" }];
    const skipped = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(skipped).toMatchObject({ ok: true, value: { skipped: [{ entityId, fieldPath: "attributes.en.title" }] } });
    const [platformAttribute] = await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(platformAttribute?.title).toBe("Owned Product");
    expect(platformAttribute?.description).toBe("Remote description");
    const [platformMapping] = await built.db.select({ syncHash: channelEntityMap.syncHash }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(platformMapping?.syncHash).toBe(itemHash(item));

    const store = await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "store", testAdminActor);
    expect(store).toEqual({ ok: true, value: undefined });
    item.attributes = [{ locale: "en", title: "Remote Store Change", description: "Remote description 2" }];
    const converged = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(converged.ok).toBe(true);
    const [storeAttribute] = await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(storeAttribute?.title).toBe("Remote Store Change");
  });

  it("keeps a shared conflict held across later remote changes", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-shared",
      slug: "owned-product-shared",
      title: "Owned Product",
      attributes: [{ locale: "en", title: "Owned Product" }],
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    const shared = await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);
    expect(shared).toEqual({ ok: true, value: undefined });
    const local = await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local Shared Change" }, testAdminActor);
    expect(local).toEqual({ ok: true, value: undefined });

    item.attributes = [{ locale: "en", title: "Remote Shared Change" }];
    const held = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(held).toMatchObject({ ok: true, value: { conflicts: [expect.objectContaining({ fieldPath: "attributes.en.title" })] } });
    const [heldMapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(heldMapping?.heldFieldPaths).toContain("attributes.en.title");

    item.attributes = [{ locale: "en", title: "Remote Later Change" }];
    const later = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(later.ok).toBe(true);
    const [heldTitle] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(heldTitle?.title).toBe("Local Shared Change");
  });

  it("never reverts a local edit when the remote item is unchanged", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-stale-replay",
      slug: "owned-product-stale-replay",
      title: "Owned Product",
      attributes: [{ locale: "en", title: "Owned Product" }],
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    const shared = await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);
    expect(shared).toEqual({ ok: true, value: undefined });
    const local = await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local Only Edit" }, testAdminActor);
    expect(local).toEqual({ ok: true, value: undefined });

    const quiet = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(quiet.ok).toBe(true);
    const [title] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(title?.title).toBe("Local Only Edit");

    item.attributes = [{ locale: "en", title: "Remote Change After Quiet Sync" }];
    const conflicted = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(conflicted).toMatchObject({ ok: true, value: { conflicts: [expect.objectContaining({ fieldPath: "attributes.en.title" })] } });
    const [stillLocal] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(stillLocal?.title).toBe("Local Only Edit");
  });

  it("keeps each forced backfill test independent and respects platform ownership", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-backfill",
      slug: "owned-product-backfill",
      title: "Backfill Product",
      attributes: [{ locale: "en", title: "Backfill Product" }],
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    const platform = await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "platform", testAdminActor);
    expect(platform).toEqual({ ok: true, value: undefined });
    item.attributes = [{ locale: "en", title: "Remote Backfill Change" }];
    const backfill = await service.backfillCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(backfill).toMatchObject({ ok: true, value: { skipped: [{ entityId, fieldPath: "attributes.en.title" }] } });
    const [backfilledTitle] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(backfilledTitle?.title).toBe("Backfill Product");
  });

  it("enforces ownership on product update webhooks and records the routing signal", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-webhook",
      slug: "owned-product-webhook",
      title: "Webhook Product",
      metadata: { protectedKey: "original" },
      attributes: [{ locale: "en", title: "Webhook Product", description: "Original description" }],
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "platform", testAdminActor);
    await built.kernel.services.catalog.setFieldOwner(entityId, "entity.metadata.protectedKey", storeId, "platform", testAdminActor);
    const handled = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "webhook-event",
      type: "products/update",
      data: {
        id: item.externalId,
        title: "Webhook Remote Title",
        description: "Webhook Remote Description",
        metadata: { protectedKey: "remote", webhookKey: "remote-value" },
      },
    });
    expect(handled).toEqual({ ok: true, value: { processed: true } });
    const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, entityId));
    const [attribute] = await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(entity?.metadata).toEqual({ protectedKey: "original", webhookKey: "remote-value" });
    expect(attribute?.title).toBe("Webhook Product");
    expect(attribute?.description).toBe("Webhook Remote Description");
    const [storeRecord] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(storeRecord?.report).toMatchObject({ skipped: expect.arrayContaining([{ entityId, fieldPath: "attributes.en.title" }, { entityId, fieldPath: "entity.metadata.protectedKey" }]) });
  });

  it("holds shared webhook changes until they are explicitly cleared", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-webhook-shared",
      slug: "owned-product-webhook-shared",
      title: "Webhook Shared Product",
      attributes: [{ locale: "en", title: "Webhook Shared Product" }],
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);
    await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Webhook Local Change" }, testAdminActor);
    const first = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "webhook-shared-1",
      type: "products/update",
      data: { id: item.externalId, title: "Webhook Remote Change" },
    });
    expect(first.ok).toBe(true);
    const second = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "webhook-shared-2",
      type: "products/update",
      data: { id: item.externalId, title: "Webhook Remote Later Change" },
    });
    expect(second.ok).toBe(true);
    const [attribute] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(attribute?.title).toBe("Webhook Local Change");
    const [mapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.heldFieldPaths).toContain("attributes.en.title");
  });

  it("does not flip a media link out of a platform-owned current role", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-media",
      slug: "owned-product-media",
      title: "Media Product",
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    const mediaAssetId = crypto.randomUUID();
    await built.db.insert(mediaAssets).values({
      id: mediaAssetId,
      organizationId: TEST_ORG_ID,
      storageKey: "media-owned",
      filename: "media-owned.png",
      contentType: "image/png",
      size: 1,
      metadata: { channelImageExternalId: "media-owned" },
      origin: "imported",
    });
    await built.db.insert(entityMedia).values({ entityId, mediaAssetId, role: "primary", sortOrder: 0 });
    await built.kernel.services.catalog.setFieldOwner(entityId, "media.primary", storeId, "platform", testAdminActor);
    item.images = [{ externalId: "media-owned", url: "https://media-owned.test/image.png", role: "gallery" }];
    const converged = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(converged).toMatchObject({ ok: true, value: { skipped: [{ entityId, fieldPath: "media.primary" }] } });
    const [link] = await built.db.select({ role: entityMedia.role }).from(entityMedia).where(and(eq(entityMedia.entityId, entityId), eq(entityMedia.mediaAssetId, mediaAssetId)));
    expect(link?.role).toBe("primary");
  });

  it("does not let a seeded store row shadow an explicit global platform owner", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-global-platform",
      slug: "owned-product-global-platform",
      title: "Global Platform Product",
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    await built.db.delete(catalogFieldOwnership).where(and(
      eq(catalogFieldOwnership.entityId, entityId),
      eq(catalogFieldOwnership.storeId, storeId),
      eq(catalogFieldOwnership.fieldPath, "attributes.en.title"),
    ));
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", null, "platform", testAdminActor);
    item.attributes = [{ locale: "en", title: "Global Remote Change" }];
    const converged = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(converged).toMatchObject({ ok: true, value: { skipped: [{ entityId, fieldPath: "attributes.en.title" }] } });
    const [attribute] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(attribute?.title).toBe("Global Platform Product");
  });

  it("does not archive an entity when status is platform-owned", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-delete",
      slug: "owned-product-delete",
      title: "Delete Product",
      status: "active",
      variants: [],
    };
    const { built, service, storeId, entityId } = await createScenario(item);
    await built.kernel.services.catalog.setFieldOwner(entityId, "entity.status", storeId, "platform", testAdminActor);
    const deleted = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "delete-event",
      type: "products/delete",
      data: { id: item.externalId },
    });
    expect(deleted.ok).toBe(true);
    const [entity] = await built.db.select({ status: sellableEntities.status }).from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(entity?.status).toBe("active");
    const [storeRecord] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(storeRecord?.report).toMatchObject({ skipped: [{ entityId, fieldPath: "entity.status" }] });
  });

  it("uses the revision timestamp as the mapping baseline", async () => {
    const item: ChannelCatalogItem = {
      externalId: "owned-product-baseline",
      slug: "owned-product-baseline",
      title: "Baseline Product",
      variants: [],
    };
    const { built, storeId, entityId } = await createScenario(item);
    const revisions = await built.db.select({ createdAt: sellableEntityRevisions.createdAt }).from(sellableEntityRevisions).where(eq(sellableEntityRevisions.entityId, entityId));
    const revision = revisions.reduce((latest, current) => current.createdAt > latest.createdAt ? current : latest);
    const [mapping] = await built.db.select({ lastSyncedAt: channelEntityMap.lastSyncedAt }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.lastSyncedAt).toEqual(revision?.createdAt);
  });
});
