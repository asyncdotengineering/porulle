/**
 * A converge attaches the SAME image set whichever path runs it.
 *
 * The page fast path imports the hero inline and defers the first photo of each other variant, then
 * the store's further photos as entity-level `gallery`, six images in all (`selectImportImages`).
 * Agent feeds publish the gallery as additional images and enrichment reads it, so the 2026-09-22
 * ruling of "hero plus one photo per variant, nothing more" no longer holds. The editor path (`convergeCatalogItems` → `applyMedia`)
 * attached EVERY image the item listed, so the first reconcile of a product whose price changed
 * uploaded and linked its whole gallery — photos the ruling excludes, each one an upload, an embed
 * and an entity bump. Found on the sim: ~2.5 extra `entity_media` rows per product.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Ok, createSystemActor, type ChannelCatalogItem, type StorageAdapter } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { entityMedia, sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);

const storage: StorageAdapter = {
  providerId: "one-image-selection-storage",
  async upload(key, _data, contentType) { return Ok({ key, url: `https://storage.test/${key}`, contentType, size: 1 }); },
  async getUrl(key) { return Ok(`https://storage.test/${key}`); },
  async getSignedUrl(key) { return Ok(`https://storage.test/${key}`); },
  async delete() { return Ok(undefined); },
  async list() { return Ok([]); },
};

function product(price: number, extraImages: NonNullable<ChannelCatalogItem["images"]> = []): ChannelCatalogItem {
  return {
    externalId: "p-1",
    slug: "p-1",
    title: "Wide-leg trouser",
    status: "active",
    images: [
      { externalId: "hero", url: "https://cdn.test/hero.png", role: "primary", sortOrder: 0 },
      { externalId: "gallery-1", url: "https://cdn.test/gallery-1.png", role: "gallery", sortOrder: 1 },
      { externalId: "gallery-2", url: "https://cdn.test/gallery-2.png", role: "gallery", sortOrder: 2 },
      ...extraImages,
    ],
    variants: [
      { externalId: "p-1-black", sku: "P1-BLACK", prices: [{ amount: price, currency: "LKR" }] },
      { externalId: "p-1-sand", sku: "P1-SAND", prices: [{ amount: price, currency: "LKR" }] },
    ],
  };
}

describe("one image selection for the fast path and the editor path", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeAll(() => {
    fetchSpy.mockImplementation(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
  });
  afterAll(() => { fetchSpy.mockRestore(); });

  async function fastPathImported() {
    const remote = { catalog: [product(1000)] };
    const connector = mockChannelConnector(remote);
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }), { storage });
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "one-image-selection.test" }),
    });
    expect(response.status).toBe(201);
    const storeId = (await response.json()).data.id as string;
    const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
    const page = await service.convergeCatalogPage(TEST_ORG_ID, storeId, remote.catalog, actor());
    expect(page.ok && page.value.failures).toEqual([]);
    const [entity] = await built.db.select({ id: sellableEntities.id }).from(sellableEntities).where(eq(sellableEntities.sourceStoreId, storeId));
    if (!entity) throw new Error("p-1 was not imported");
    const links = async () => (await built.db.select({ asset: entityMedia.mediaAssetId, role: entityMedia.role, variantId: entityMedia.variantId })
      .from(entityMedia).where(and(eq(entityMedia.entityId, entity.id)))).length;
    const imageFetches = () => fetchSpy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).startsWith("https://cdn.test/")).length;
    const deferred = page.ok ? page.value.deferredMedia : [];
    return { remote, service, storeId, links, imageFetches, deferred };
  }

  it("the fast path defers variant photos first, then the gallery as entity-level photos, six images in all", async () => {
    const extra = [
      ...[3, 4, 5, 6].map((n) => ({ externalId: `gallery-${n}`, url: `https://cdn.test/gallery-${n}.png`, role: "gallery" as const, sortOrder: n })),
      { externalId: "sand-1", url: "https://cdn.test/sand-1.png", role: "gallery" as const, sortOrder: 9, variantExternalIds: ["p-1-sand"] },
    ];
    const remote = { catalog: [product(1000, extra)] };
    const connector = mockChannelConnector(remote);
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }), { storage });
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "gallery-selection.test" }),
    });
    const storeId = (await response.json()).data.id as string;
    const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
    const page = await service.convergeCatalogPage(TEST_ORG_ID, storeId, remote.catalog, actor());
    if (!page.ok) throw new Error("page failed");
    const images = page.value.deferredMedia[0]?.images ?? [];
    expect(images.map((image) => image.externalId)).toEqual(["sand-1", "gallery-1", "gallery-2", "gallery-3", "gallery-4"]);
    expect(images.slice(1).every((image) => image.role === "gallery" && (image.variantExternalIds ?? []).length === 0)).toBe(true);
  }, 120_000);

  it("the editor path lands exactly what the fast path deferred, and a price-only change after it attaches and uploads nothing", async () => {
    const { remote, service, storeId, links, imageFetches, deferred } = await fastPathImported();
    expect(await links()).toBe(1); // the hero inline; the gallery waits for the host's media lane
    const deferredCount = deferred.reduce((sum, item) => sum + item.images.length, 0);
    expect(deferredCount).toBe(2);

    remote.catalog[0] = product(1100);
    await service.reconcile(TEST_ORG_ID, storeId, actor());
    expect(await links()).toBe(1 + deferredCount);

    const fetchesBefore = imageFetches();
    remote.catalog[0] = product(1200);
    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { converged: result.value.converged, failures: result.value.failures ?? [] }).toEqual({ converged: 1, failures: [] });
    expect(await links()).toBe(1 + deferredCount);
    expect(imageFetches() - fetchesBefore).toBe(0);
  }, 120_000);

  it("a genuinely new variant photo is attached once, and a second reconcile adds nothing", async () => {
    const { remote, service, storeId, links, imageFetches } = await fastPathImported();
    remote.catalog[0] = product(1100);
    await service.reconcile(TEST_ORG_ID, storeId, actor()); // a change takes the editor path, which lands the deferred gallery
    const linksBefore = await links();
    const fetchesBefore = imageFetches();
    remote.catalog[0] = product(1000, [{ externalId: "sand-1", url: "https://cdn.test/sand-1.png", role: "gallery", sortOrder: 3, variantExternalIds: ["p-1-sand"] }]);

    await service.reconcile(TEST_ORG_ID, storeId, actor());
    const linksAfter = await links();
    await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(linksAfter).toBe(linksBefore + 1);
    expect(await links()).toBe(linksAfter);
    expect(imageFetches() - fetchesBefore).toBe(1);
  }, 120_000);
});
