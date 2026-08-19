import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  createSystemActor,
  noopStorageAdapter,
  type Actor,
  type ChannelCatalogItem,
  type PluginTxFn,
  type StorageAdapter,
} from "@porulle/core";
import { and, eq, inArray } from "@porulle/core/drizzle";
import {
  brands,
  categories,
  entityBrands,
  entityCategories,
  entityMedia,
  entityTags,
  mediaAssets,
  optionTypes,
  optionValues,
  prices,
  sellableAttributes,
  sellableEntities,
  tags,
  variantOptionValues,
  variants,
} from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor: Actor = testAdminActor;
const imageBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).buffer;

function countingStorage(): StorageAdapter & { uploads: string[] } {
  const uploads: string[] = [];
  return {
    providerId: "test-counting-storage",
    uploads,
    async upload(key, data, contentType) {
      uploads.push(key);
      const body = data instanceof ArrayBuffer ? data : await new Response(data).arrayBuffer();
      return {
        ok: true,
        value: { key, url: `https://storage.test/${key}`, contentType, size: body.byteLength },
      };
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

const remoteItem: ChannelCatalogItem = {
  externalId: "full-pim-product",
  slug: "full-pim-product",
  title: "Channel Product",
  description: "Default description that belongs in attributes.",
  metadata: { remoteOnly: "remote-value" },
  attributes: [
    { locale: "en", title: "Channel Product", description: "English description" },
    { locale: "fr", title: "Produit de canal", description: "Description française" },
  ],
  options: [
    {
      name: "color",
      displayName: "Color",
      sortOrder: 0,
      values: [
        { value: "red", displayValue: "Red", sortOrder: 0 },
        { value: "blue", displayValue: "Blue", sortOrder: 1 },
      ],
    },
    {
      name: "size",
      displayName: "Size",
      sortOrder: 1,
      values: [
        { value: "small", displayValue: "Small", sortOrder: 0 },
        { value: "large", displayValue: "Large", sortOrder: 1 },
      ],
    },
  ],
  images: [
    { externalId: "full-image-primary", url: "https://channel.test/full-primary.png", role: "primary", sortOrder: 0, alt: "Primary" },
    { externalId: "full-image-red", url: "https://channel.test/full-red.png", role: "gallery", sortOrder: 1, variantExternalIds: ["full-v1", "full-v2"], alt: "Red" },
    { externalId: "full-image-blue", url: "https://channel.test/full-blue.png", role: "gallery", sortOrder: 2, variantExternalIds: ["full-v3", "full-v4"], alt: "Blue" },
  ],
  brand: "channel-brand",
  categories: ["channel-category", "featured-channel-category"],
  tags: ["channel", "featured"],
  status: "active",
  variants: [
    { externalId: "full-v1", sku: "FULL-RED-S", optionValues: { color: "red", size: "small" }, prices: [{ currency: "USD", amount: 1000, compareAtAmount: 1200 }] },
    { externalId: "full-v2", sku: "FULL-RED-L", optionValues: { color: "red", size: "large" }, prices: [{ currency: "USD", amount: 1100 }] },
    { externalId: "full-v3", sku: "FULL-BLUE-S", optionValues: { color: "blue", size: "small" }, prices: [{ currency: "USD", amount: 1000 }] },
    { externalId: "full-v4", sku: "FULL-BLUE-L", optionValues: { color: "blue", size: "large" }, prices: [{ currency: "USD", amount: 1100 }] },
  ],
};

describe("channel connector PIM convergence", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let storage: StorageAdapter & { uploads: string[] };
  let storeId: string;
  let entityId: string;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeAll(async () => {
    storage = countingStorage();
    fetchSpy.mockImplementation(async () => new Response(imageBytes, {
      headers: { "content-type": "image/png" },
    }));
    const mock = mockChannelConnector({ catalog: [remoteItem] });
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock] }), { storage });
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
        storeDomain: "full-pim.test",
        webhookSecret: "full-pim-secret",
      }),
    });
    expect(response.status).toBe(201);
    storeId = (await response.json()).data.id as string;
  }, 30_000);

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  it("converges every mapped PIM surface and replays idempotently", async () => {
    const imported = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(imported).toEqual({ ok: true, value: { imported: 1, cursor: null } });

    const [entity] = await built.db.select().from(sellableEntities).where(and(
      eq(sellableEntities.organizationId, TEST_ORG_ID),
      eq(sellableEntities.sourceStoreId, storeId),
      eq(sellableEntities.slug, remoteItem.slug),
    ));
    expect(entity).toBeDefined();
    entityId = entity!.id;

    const attributes = await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    const entityImages = await built.db.select().from(entityMedia).where(eq(entityMedia.entityId, entityId));
    const assets = await built.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, TEST_ORG_ID));
    const optionTypeRows = await built.db.select().from(optionTypes).where(eq(optionTypes.entityId, entityId));
    const values = (await Promise.all(optionTypeRows.map((optionType) =>
      built.db.select().from(optionValues).where(eq(optionValues.optionTypeId, optionType.id))))).flat();
    const variantRows = await built.db.select().from(variants).where(eq(variants.entityId, entityId));
    const variantOptions = await built.db.select().from(variantOptionValues).where(eq(variantOptionValues.variantId, variantRows[0]!.id));
    const allVariantOptions = await built.db.select().from(variantOptionValues).where(inArray(variantOptionValues.variantId, variantRows.map((variant) => variant.id)));
    const priceRows = await built.db.select().from(prices).where(and(
      eq(prices.organizationId, TEST_ORG_ID),
      eq(prices.entityId, entityId),
    ));
    const brandLinks = await built.db.select().from(entityBrands).where(eq(entityBrands.entityId, entityId));
    const categoryLinks = await built.db.select().from(entityCategories).where(eq(entityCategories.entityId, entityId));
    const tagLinks = await built.db.select().from(entityTags).where(eq(entityTags.entityId, entityId));
    const brandRows = await built.db.select().from(brands).where(eq(brands.organizationId, TEST_ORG_ID));
    const categoryRows = await built.db.select().from(categories).where(eq(categories.organizationId, TEST_ORG_ID));
    const tagRows = await built.db.select().from(tags).where(eq(tags.organizationId, TEST_ORG_ID));

    expect(attributes).toHaveLength(2);
    expect(entityImages).toHaveLength(5);
    expect(assets).toHaveLength(3);
    expect(assets.every((asset) => asset.origin === "imported")).toBe(true);
    expect(optionTypeRows).toHaveLength(2);
    expect(values).toHaveLength(4);
    expect(variantRows).toHaveLength(4);
    expect(variantOptions).toHaveLength(2);
    expect(allVariantOptions).toHaveLength(8);
    expect(priceRows).toHaveLength(4);
    expect(priceRows.find((price) => price.variantId === variantRows[0]!.id)).toMatchObject({ compareAtAmount: 1200 });
    expect(brandRows.some((brand) => brand.slug === "channel-brand")).toBe(true);
    expect(categoryRows.filter((category) => ["channel-category", "featured-channel-category"].includes(category.slug))).toHaveLength(2);
    expect(brandLinks).toHaveLength(1);
    expect(categoryLinks).toHaveLength(2);
    expect(tagRows.filter((tag) => ["channel", "featured"].includes(tag.slug))).toHaveLength(2);
    expect(tagLinks).toHaveLength(2);
    expect(entity?.status).toBe("active");
    expect(entity?.metadata).toEqual({ remoteOnly: "remote-value" });
    expect(storage.uploads).toHaveLength(3);

    const merchantEdit = await built.kernel.services.catalog.update(entityId, { metadata: { merchantOnly: "keep" } }, actor);
    expect(merchantEdit.ok).toBe(true);
    remoteItem.metadata = { remoteOnly: "remote-value-2" };

    const replay = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(replay).toEqual({ ok: true, value: { imported: 0, cursor: null } });
    const unchangedReplay = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(unchangedReplay).toEqual({ ok: true, value: { imported: 0, cursor: null } });
    expect((await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId)))).toHaveLength(2);
    expect((await built.db.select().from(entityMedia).where(eq(entityMedia.entityId, entityId)))).toHaveLength(5);
    expect((await built.db.select().from(optionValues).where(eq(optionValues.optionTypeId, values[0]!.optionTypeId)))).toHaveLength(2);
    expect((await built.db.select().from(variantOptionValues).where(inArray(variantOptionValues.variantId, variantRows.map((variant) => variant.id))))).toHaveLength(8);
    expect((await built.db.select().from(prices).where(and(eq(prices.organizationId, TEST_ORG_ID), eq(prices.entityId, entityId))))).toHaveLength(4);
    expect((await built.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, TEST_ORG_ID)))).toHaveLength(3);
    expect((await built.db.select().from(entityTags).where(eq(entityTags.entityId, entityId)))).toHaveLength(2);
    expect(storage.uploads).toHaveLength(3);

    const [replayedEntity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, entityId));
    expect(replayedEntity?.metadata).toEqual({ merchantOnly: "keep", remoteOnly: "remote-value-2" });
  });

  it("reports skipped media when the configured adapter is the no-op adapter", async () => {
    const mock = mockChannelConnector({ catalog: [{ ...remoteItem, externalId: "noop-media-product", slug: "noop-media-product" }] });
    const noStorage = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock] }), { storage: noopStorageAdapter });
    const noStorageService = new ChannelConnectorService(
      noStorage.db,
      noStorage.kernel.services,
      { connectors: [mock] },
      noStorage.kernel.database.transaction as PluginTxFn,
    );
    const response = await noStorage.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "noop-media.test" }),
    });
    const noStorageStoreId = (await response.json()).data.id as string;
    const result = await noStorageService.importCatalog(TEST_ORG_ID, noStorageStoreId, createSystemActor(TEST_ORG_ID));
    expect(result).toMatchObject({ ok: true, value: { imported: 1, cursor: null, warnings: expect.arrayContaining([expect.stringContaining("storage")] ) } });
  }, 30_000);
});
