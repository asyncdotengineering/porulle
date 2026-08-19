import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type ChannelStore, type PluginTxFn, type StorageAdapter } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { optionTypes, optionValues, sellableAttributes, sellableEntities, variantOptionValues, variants } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, connectedStores } from "../src/schema.js";

const item: ChannelCatalogItem = {
  externalId: "legacy-product",
  slug: "legacy-product",
  title: "Legacy Product",
  description: "Legacy description",
  options: [{ name: "color", displayName: "Color", values: [{ value: "red", displayValue: "Red" }] }],
  variants: [{ externalId: "legacy-variant", sku: "LEGACY-RED", optionValues: { color: "red" } }],
};

const connectorOptions: { catalog: ChannelCatalogItem[] } = { catalog: [item] };
const connector = mockChannelConnector(connectorOptions);

function itemHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function countingStorage(): StorageAdapter & { uploads: number } {
  const storage = { uploads: 0 };
  return {
    providerId: "backfill-test-storage",
    get uploads() {
      return storage.uploads;
    },
    async upload(key, data, contentType) {
      storage.uploads += 1;
      const body = data instanceof ArrayBuffer ? data : await new Response(data).arrayBuffer();
      return { ok: true, value: { key, url: `https://storage.test/${key}`, contentType, size: body.byteLength } };
    },
    async getUrl(key) {
      return { ok: true, value: `https://storage.test/${key}` };
    },
    async getSignedUrl(key) {
      return { ok: true, value: `https://storage.test/${key}` };
    },
    async delete() {
      return { ok: true, value: undefined };
    },
    async list() {
      return { ok: true, value: [] };
    },
  };
}

describe("channel catalog backfill", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let storeId: string;
  let entityId: string;
  let variantId: string;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [connector] },
      built.kernel.database.transaction as PluginTxFn,
    );

    const [store] = await built.db.insert(connectedStores).values({
      organizationId: TEST_ORG_ID,
      provider: "mock",
      credentials: {},
      storeDomain: "legacy-backfill.test",
    }).returning({ id: connectedStores.id });
    storeId = store!.id;

    const [entity] = await built.db.insert(sellableEntities).values({
      organizationId: TEST_ORG_ID,
      sourceStoreId: storeId,
      type: "product",
      slug: "legacy-product",
      status: "active",
      isVisible: true,
      metadata: { title: "Legacy Product", description: "Legacy description", retained: true },
    }).returning({ id: sellableEntities.id });
    entityId = entity!.id;

    const [variant] = await built.db.insert(variants).values({
      entityId,
      organizationId: TEST_ORG_ID,
      sourceStoreId: storeId,
      sku: "LEGACY-RED",
    }).returning({ id: variants.id });
    variantId = variant!.id;

    await built.db.insert(channelEntityMap).values([
      { organizationId: TEST_ORG_ID, storeId, kind: "entity", externalId: item.externalId, entityId, syncHash: "legacy" },
      { organizationId: TEST_ORG_ID, storeId, kind: "variant", externalId: "legacy-variant", entityId, variantId, syncHash: "legacy" },
    ]);
  }, 30_000);

  async function seedLegacyEntity(
    suffix: string,
    sourceStoreId = storeId,
    syncHash = "legacy",
    externalId = `legacy-${suffix}`,
    variantExternalId = `${externalId}-variant`,
  ): Promise<{ entityId: string; variantId: string }> {
    const [entity] = await built.db.insert(sellableEntities).values({
      organizationId: TEST_ORG_ID,
      sourceStoreId,
      type: "product",
      slug: `legacy-${suffix}`,
      status: "active",
      isVisible: true,
      metadata: { title: `Legacy ${suffix}`, description: `Description ${suffix}`, retained: suffix },
    }).returning({ id: sellableEntities.id });
    const [variant] = await built.db.insert(variants).values({
      entityId: entity!.id,
      organizationId: TEST_ORG_ID,
      sourceStoreId,
      sku: `LEGACY-${suffix}`,
    }).returning({ id: variants.id });
    await built.db.insert(channelEntityMap).values([
      { organizationId: TEST_ORG_ID, storeId: sourceStoreId, kind: "entity", externalId, entityId: entity!.id, syncHash },
      { organizationId: TEST_ORG_ID, storeId: sourceStoreId, kind: "variant", externalId: variantExternalId, entityId: entity!.id, variantId: variant!.id, syncHash },
    ]);
    return { entityId: entity!.id, variantId: variant!.id };
  }

  it("promotes legacy metadata and repairs the complete PIM shape", async () => {
    const result = await service.backfillCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(result).toEqual({
      ok: true,
      value: {
        entitiesTouched: 1,
        attributesCreated: 1,
        mediaImported: 0,
        variantsGivenOptionValues: 1,
        cursor: null,
        complete: true,
      },
    });

    const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(entity?.metadata).toEqual({ retained: true });
    expect(await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId))).toHaveLength(1);
    expect(await built.db.select().from(optionTypes).where(eq(optionTypes.entityId, entityId))).toHaveLength(1);
    expect(await built.db.select().from(variantOptionValues).where(eq(variantOptionValues.variantId, variantId))).toHaveLength(1);
    expect((await built.db.select().from(channelEntityMap).where(and(
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
    )))[0]?.syncHash).not.toBe("legacy");
  });

  it("is idempotent on a second pass", async () => {
    const second = await service.backfillCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(second).toEqual({
      ok: true,
      value: {
        entitiesTouched: 0,
        attributesCreated: 0,
        mediaImported: 0,
        variantsGivenOptionValues: 0,
        cursor: null,
        complete: true,
      },
    });
  });

  it("keeps another store's legacy entities isolated", async () => {
    const [otherStore] = await built.db.insert(connectedStores).values({
      organizationId: TEST_ORG_ID,
      provider: "mock",
      credentials: {},
      storeDomain: "other-backfill.test",
    }).returning({ id: connectedStores.id });
    const other = await seedLegacyEntity("other-store", otherStore!.id);
    const result = await service.backfillCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(result.ok).toBe(true);
    expect(await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, other.entityId))).toHaveLength(0);
    const [unchanged] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, other.entityId));
    expect(unchanged?.metadata).toMatchObject({ title: "Legacy other-store", description: "Description other-store" });
  });

  it("repairs partial option axes even when the mapping hash already matches", async () => {
    const partial: ChannelCatalogItem = {
      externalId: "partial-product",
      slug: "partial-product",
      title: "Partial Product",
      variants: [{ externalId: "partial-variant", sku: "PARTIAL", optionValues: { color: "red", size: "large" } }],
      options: [
        { name: "color", displayName: "Color", values: [{ value: "red", displayValue: "Red" }] },
        { name: "size", displayName: "Size", values: [{ value: "large", displayValue: "Large" }] },
      ],
    };
    connectorOptions.catalog.push(partial);
    const seeded = await seedLegacyEntity("partial", storeId, itemHash(partial), "partial-product", "partial-variant");
    const [color] = await built.db.insert(optionTypes).values({ entityId: seeded.entityId, name: "color", displayName: "Color" }).returning({ id: optionTypes.id });
    const [size] = await built.db.insert(optionTypes).values({ entityId: seeded.entityId, name: "size", displayName: "Size" }).returning({ id: optionTypes.id });
    const [red] = await built.db.insert(optionValues).values({ optionTypeId: color!.id, value: "red", displayValue: "Red" }).returning({ id: optionValues.id });
    await built.db.insert(optionValues).values({ optionTypeId: size!.id, value: "large", displayValue: "Large" });
    await built.db.insert(variantOptionValues).values({ variantId: seeded.variantId, optionValueId: red!.id });

    const result = await service.backfillCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(result).toMatchObject({ ok: true, value: { variantsGivenOptionValues: 1 } });
    const optionLinks = await built.db.select().from(variantOptionValues).where(eq(variantOptionValues.variantId, seeded.variantId));
    expect(optionLinks).toHaveLength(2);
  });

  it("dry-run reports the actual changes without writing them", async () => {
    const dryItem: ChannelCatalogItem = {
      externalId: "dry-run-product",
      slug: "dry-run-product",
      title: "Dry Run Product",
      variants: [{ externalId: "dry-run-variant", sku: "DRY-RUN", optionValues: { color: "red" } }],
      options: [{ name: "color", displayName: "Color", values: [{ value: "red", displayValue: "Red" }] }],
    };
    connectorOptions.catalog.push(dryItem);
    const seeded = await seedLegacyEntity("dry-run", storeId, "legacy", "dry-run-product", "dry-run-variant");
    const before = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, seeded.entityId));
    const dryRun = await service.backfillCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID), { dryRun: true });
    expect(dryRun).toMatchObject({ ok: true, value: { entitiesTouched: 1, attributesCreated: 1, variantsGivenOptionValues: 1, mediaImported: 0, complete: true, cursor: null } });
    expect(await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, seeded.entityId))).toHaveLength(0);
    expect(await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, seeded.entityId))).toEqual(before);
    const applied = await service.backfillCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(applied).toMatchObject({ ok: true, value: { entitiesTouched: 1, attributesCreated: 1, variantsGivenOptionValues: 1, mediaImported: 0, complete: true, cursor: null } });
  });

  it("promotes local legacy attributes before a remote catalog failure", async () => {
    const base = mockChannelConnector({ catalog: [] });
    const unavailableConnector = {
      ...base,
      providerId: "unavailable",
      async importCatalog() {
        return { ok: false as const, error: { code: "REMOTE_UNAVAILABLE", message: "remote unavailable" } };
      },
    };
    const unavailableService = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [unavailableConnector] },
      built.kernel.database.transaction as PluginTxFn,
    );
    const [unavailableStore] = await built.db.insert(connectedStores).values({
      organizationId: TEST_ORG_ID,
      provider: "unavailable",
      credentials: {},
      storeDomain: "unavailable-backfill.test",
    }).returning({ id: connectedStores.id });
    const seeded = await seedLegacyEntity("unavailable", unavailableStore!.id);
    const result = await unavailableService.backfillCatalog(TEST_ORG_ID, unavailableStore!.id, createSystemActor(TEST_ORG_ID));
    expect(result).toMatchObject({ ok: false, error: "remote unavailable" });
    expect(await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, seeded.entityId))).toHaveLength(1);
    const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, seeded.entityId));
    expect(entity?.metadata).toEqual({ retained: "unavailable" });
  });

  it("reports imported media and does not upload it again", async () => {
    const mediaItem: ChannelCatalogItem = {
      externalId: "media-backfill",
      slug: "media-backfill",
      title: "Media Backfill",
      images: [{ externalId: "media-image", url: "https://channel.test/media.png", role: "primary" }],
      variants: [],
    };
    const mediaConnector = mockChannelConnector({ catalog: [mediaItem] });
    const storage = countingStorage();
    const mediaBuilt = await createPluginTestApp(channelConnectorPlugin({ connectors: [mediaConnector] }), { storage });
    const mediaService = new ChannelConnectorService(
      mediaBuilt.db,
      mediaBuilt.kernel.services,
      { connectors: [mediaConnector] },
      mediaBuilt.kernel.database.transaction as PluginTxFn,
    );
    const [mediaStore] = await mediaBuilt.db.insert(connectedStores).values({
      organizationId: TEST_ORG_ID,
      provider: "mock",
      credentials: {},
      storeDomain: "media-backfill.test",
    }).returning({ id: connectedStores.id });
    const [mediaEntity] = await mediaBuilt.db.insert(sellableEntities).values({
      organizationId: TEST_ORG_ID,
      sourceStoreId: mediaStore!.id,
      type: "product",
      slug: "media-backfill",
      status: "active",
      isVisible: true,
      metadata: { title: "Media Backfill", description: "Media description" },
    }).returning({ id: sellableEntities.id });
    await mediaBuilt.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId: mediaStore!.id,
      kind: "entity",
      externalId: mediaItem.externalId,
      entityId: mediaEntity!.id,
      syncHash: "legacy",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    try {
      const first = await mediaService.backfillCatalog(TEST_ORG_ID, mediaStore!.id, createSystemActor(TEST_ORG_ID));
      expect(first).toMatchObject({ ok: true, value: { entitiesTouched: 1, attributesCreated: 1, mediaImported: 1 } });
      const second = await mediaService.backfillCatalog(TEST_ORG_ID, mediaStore!.id, createSystemActor(TEST_ORG_ID));
      expect(second).toMatchObject({ ok: true, value: { entitiesTouched: 0, attributesCreated: 0, mediaImported: 0 } });
      expect(storage.uploads).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("persists page progress and resumes from the saved cursor", async () => {
    const firstPage: ChannelCatalogItem = { externalId: "paged-first", slug: "paged-first", title: "Paged First", variants: [] };
    const secondPage: ChannelCatalogItem = { externalId: "paged-second", slug: "paged-second", title: "Paged Second", variants: [] };
    const base = mockChannelConnector({ catalog: [] });
    const pagedConnector = {
      ...base,
      async importCatalog(_store: ChannelStore, cursor?: string) {
        return cursor === undefined
          ? { ok: true as const, value: { items: [firstPage], nextCursor: "page-2" } }
          : { ok: true as const, value: { items: [secondPage], nextCursor: null } };
      },
    };
    const pagedBuilt = await createPluginTestApp(channelConnectorPlugin({ connectors: [pagedConnector] }));
    const pagedService = new ChannelConnectorService(
      pagedBuilt.db,
      pagedBuilt.kernel.services,
      { connectors: [pagedConnector] },
      pagedBuilt.kernel.database.transaction as PluginTxFn,
    );
    const [pagedStore] = await pagedBuilt.db.insert(connectedStores).values({
      organizationId: TEST_ORG_ID,
      provider: "mock",
      credentials: {},
      storeDomain: "paged-backfill.test",
    }).returning({ id: connectedStores.id });

    const first = await pagedService.backfillCatalog(TEST_ORG_ID, pagedStore!.id, createSystemActor(TEST_ORG_ID), { maxPages: 1 });
    expect(first).toMatchObject({ ok: true, value: { complete: false, cursor: "page-2", entitiesTouched: 1 } });
    const [checkpoint] = await pagedBuilt.db.select({ breakerState: connectedStores.breakerState }).from(connectedStores).where(eq(connectedStores.id, pagedStore!.id));
    expect((checkpoint?.breakerState.catalogBackfill as { cursor?: string }).cursor).toBe("page-2");

    const resumed = await pagedService.backfillCatalog(TEST_ORG_ID, pagedStore!.id, createSystemActor(TEST_ORG_ID), { resume: true, maxPages: 1 });
    expect(resumed).toMatchObject({ ok: true, value: { complete: true, cursor: null, entitiesTouched: 2, attributesCreated: 2 } });
  });

  it("exposes the operator route and durable per-store job", async () => {
    const task = (built.kernel.config.jobs?.tasks ?? []).find((definition) => definition.slug === "channel/backfill-catalog");
    expect(task?.concurrency?.key({ storeId })).toBe(storeId);
    const response = await built.app.request(`http://localhost/api/channels/stores/${storeId}/backfill`, {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ dryRun: true }),
    });
    expect([200, 201]).toContain(response.status);
    expect((await response.json()).data).toMatchObject({ complete: true, cursor: null });
  });

  it("enqueues the durable job for a non-dry-run trigger instead of running inline", async () => {
    const response = await built.app.request(`http://localhost/api/channels/stores/${storeId}/backfill`, {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({}),
    });
    expect([200, 201]).toContain(response.status);
    expect((await response.json()).data).toMatchObject({ enqueued: true, storeId });
  });

  it("never overwrites manually-set attributes with the stale metadata copy", async () => {
    const { entityId } = await seedLegacyEntity("precedence");
    await built.db.insert(sellableAttributes).values({
      entityId,
      locale: "en",
      title: "Curated title",
    });

    const result = await service.backfillCatalog(TEST_ORG_ID, storeId, testAdminActor, { dryRun: true });
    expect(result.ok).toBe(true);

    const rows = await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Curated title" });
    const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(entity?.metadata).toMatchObject({ title: "Legacy precedence" });
  });
});
