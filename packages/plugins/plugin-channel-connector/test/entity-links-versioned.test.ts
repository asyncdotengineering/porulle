/**
 * A converge that changes an entity's LINKS — tags, categories, brand, media — must version the
 * entity, once, in the transaction that writes them; a converge that changes nothing must version
 * nothing; and a converge that CREATES the entity must not version it for its links at all.
 *
 * Tags, categories and brand are indexed search facets and the hero image drives the image
 * embedding. A tag-only upstream change once left `sellable_entities.updated_at` where it was and
 * the index kept the old tags. Versioning every link through its own service call fixed that and
 * cost a notify per link — a new product's first import re-projected it once per category, tag and
 * image. So: the converge writes an item's links through the shared link writer and fires ONE
 * `catalog.afterUpdate` with the union of paths, and none for an entity it just created.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Ok, createSystemActor, type ChannelCatalogItem, type PluginDb, type StorageAdapter } from "@porulle/core";
import { and, count, eq } from "@porulle/core/drizzle";
import { entityMedia, entityTags, sellableEntities } from "@porulle/core/schema";
import { createPGliteTestAdapter, createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

const storage: StorageAdapter = {
  providerId: "links-versioned-storage",
  async upload(key, _data, contentType) { return Ok({ key, url: `https://storage.test/${key}`, contentType, size: 1 }); },
  async getUrl(key) { return Ok(`https://storage.test/${key}`); },
  async getSignedUrl(key) { return Ok(`https://storage.test/${key}`); },
  async delete() { return Ok(undefined); },
  async list() { return Ok([]); },
};

function product(externalId: string, extra: Partial<ChannelCatalogItem> = {}): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: `Product ${externalId}`,
    attributes: [{ locale: "en", title: `Product ${externalId}` }],
    status: "active",
    tags: ["linen"],
    categories: ["trousers"],
    brand: "Atelier",
    images: [{ externalId: `${externalId}-hero`, url: `https://cdn.test/${externalId}-hero.png`, role: "primary", sortOrder: 0 }],
    variants: [{ externalId: `${externalId}-v1`, sku: `${externalId}-SKU`, prices: [{ amount: 1000, currency: "LKR" }] }],
    ...extra,
  };
}

/**
 * A connected store over its own PGlite, so `queryLog` sees every statement the converge causes —
 * the catalog and media services' included, which a proxy over the connector's handle cannot.
 * `afterTransactionBody` runs inside each transaction the service opens, after its body, on its handle.
 */
async function connectedStore(catalog: ChannelCatalogItem[]) {
  const remote = { catalog };
  const connector = mockChannelConnector(remote);
  const pglite = await createPGliteTestAdapter();
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }), { databaseAdapter: pglite.adapter, storage });
  const updates: Array<{ id: string; paths: unknown }> = [];
  built.kernel.hooks.append("catalog.afterUpdate", async (args: { result: { id: string }; context: { context: Record<string, unknown> } }) => {
    updates.push({ id: args.result.id, paths: args.context.context.changedFieldPaths });
  });
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "links-versioned.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const hooks: { afterTransactionBody: ((tx: PluginDb) => Promise<void>) | undefined } = { afterTransactionBody: undefined };
  // Observed on the db HANDLE, the argument the deployed job passes too (see construction-parity).
  const observed = new Proxy(built.db, {
    get(target, property) {
      if (property === "transaction") {
        return <T>(fn: (tx: PluginDb) => Promise<T>): Promise<T> => target.transaction(async (tx) => {
          const result = await fn(tx);
          await hooks.afterTransactionBody?.(tx);
          return result;
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new ChannelConnectorService(observed, built.kernel.services, { connectors: [connector] });
  const versions = async () => new Map(
    (await built.db.select({ id: sellableEntities.id, slug: sellableEntities.slug, at: sellableEntities.updatedAt }).from(sellableEntities)
      .where(eq(sellableEntities.sourceStoreId, storeId)))
      .map((row) => [row.slug, { id: row.id, at: row.at.getTime() }]),
  );
  return { remote, service, storeId, versions, updates, queryLog: pglite.queryLog, db: built.db, hooks, cleanup: pglite.cleanup };
}

async function importedStore() {
  const store = await connectedStore([product("p-1"), product("p-2")]);
  const imported = await store.service.reconcile(TEST_ORG_ID, store.storeId, actor());
  expect(imported.ok && { imported: imported.value.imported, failures: imported.value.failures ?? [] }).toEqual({ imported: 2, failures: [] });
  return store;
}

describe("entity link changes on converge", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeAll(() => {
    fetchSpy.mockImplementation(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
  });
  afterAll(() => { fetchSpy.mockRestore(); });

  it("a tag-only upstream change moves that product's updated_at, and only that product's", async () => {
    const { remote, service, storeId, versions } = await importedStore();
    const before = await versions();
    await pause();
    remote.catalog[0] = product("p-1", { tags: ["linen", "summer"] });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(1);
    const after = await versions();
    expect(after.get("p-1")?.at).toBeGreaterThan(before.get("p-1")?.at ?? Infinity);
    expect(after.get("p-2")).toEqual(before.get("p-2"));
  }, 120_000);

  it("a category-only upstream change moves that product's updated_at", async () => {
    const { remote, service, storeId, versions } = await importedStore();
    const before = await versions();
    await pause();
    remote.catalog[1] = product("p-2", { categories: ["trousers", "wide-leg"] });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(1);
    expect((await versions()).get("p-2")?.at).toBeGreaterThan(before.get("p-2")?.at ?? Infinity);
  }, 120_000);

  it("(a) cold import: N new products fire no link afterUpdate, and cost no more statements than 0.54.0", async () => {
    const N = 5;
    const { service, storeId, updates, queryLog } = await connectedStore(Array.from({ length: N }, (_, index) => product(`cold-${index}`, {
      tags: ["linen", "summer"],
      categories: ["trousers", "wide-leg"],
      images: [
        { externalId: `cold-${index}-hero`, url: `https://cdn.test/cold-${index}-hero.png`, role: "primary", sortOrder: 0 },
        { externalId: `cold-${index}-side`, url: `https://cdn.test/cold-${index}-side.png`, role: "gallery", sortOrder: 1 },
      ],
    })));

    queryLog.start();
    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());
    const statements = queryLog.stop().length;

    expect(result.ok && { imported: result.value.imported, failures: result.value.failures ?? [] }).toEqual({ imported: N, failures: [] });
    // Measured on this fixture, same test body, whole-database statement log (N = 5):
    //   0.54.0  link writes through the catalog/media services, links not versioned   afterUpdate 5   statements 732
    //   #148 head before this row, a notify per link                                   afterUpdate 35  statements 912
    //   0.55.0  shared link writer, one tx per item, a new entity not versioned        afterUpdate 5   statements 397
    // The 5 are the new products' titles (`setAttributes`), at 0.54.0 as now; none is a link path.
    // The statements fell because a service call per link also captured a revision per link; the
    // converge still records its one revision per touched item.
    expect(updates.map((update) => update.paths)).toEqual(Array.from({ length: N }, () => ["attributes.en.title"]));
    expect(statements).toBeLessThanOrEqual(732);
  }, 120_000);

  it("(b) an update adding a category, a tag and an image fires ONE afterUpdate with the union of paths, and bumps once", async () => {
    const { remote, service, storeId, versions, updates } = await importedStore();
    const before = await versions();
    await pause();
    remote.catalog[0] = product("p-1", {
      tags: ["linen", "summer"],
      categories: ["trousers", "wide-leg"],
      images: [
        { externalId: "p-1-hero", url: "https://cdn.test/p-1-hero.png", role: "primary", sortOrder: 0 },
        { externalId: "p-1-side", url: "https://cdn.test/p-1-side.png", role: "gallery", sortOrder: 1 },
      ],
    });
    const firedBefore = updates.length;

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { converged: result.value.converged, failures: result.value.failures ?? [] }).toEqual({ converged: 1, failures: [] });
    const p1 = before.get("p-1");
    expect(updates.slice(firedBefore)).toEqual([{ id: p1?.id, paths: ["categories", "media.gallery", "tags"] }]);
    const after = await versions();
    expect(after.get("p-1")?.at).toBeGreaterThan(p1?.at ?? Infinity);
    expect(after.get("p-2")).toEqual(before.get("p-2"));
  }, 120_000);

  it("(b) a re-placed image (gallery → primary) names both roles", async () => {
    const { remote, service, storeId, versions, updates } = await importedStore();
    const p1 = (await versions()).get("p-1");
    remote.catalog[0] = product("p-1", { images: [{ externalId: "p-1-hero", url: "https://cdn.test/p-1-hero.png", role: "gallery", sortOrder: 3 }] });
    const firedBefore = updates.length;

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(1);
    expect(updates.slice(firedBefore)).toEqual([{ id: p1?.id, paths: ["media.gallery", "media.primary"] }]);
  }, 120_000);

  it("(c) the bump commits in the link write's transaction: roll that transaction back and neither survives", async () => {
    const { remote, service, storeId, versions, updates, db, hooks } = await importedStore();
    const before = await versions();
    const p1 = before.get("p-1");
    if (!p1) throw new Error("p-1 was not imported");
    const tagCount = async (handle: PluginDb) =>
      (await handle.select({ n: count() }).from(entityTags).where(eq(entityTags.entityId, p1.id)))[0]?.n ?? 0;
    const tagsBefore = await tagCount(db);
    await pause();
    remote.catalog[0] = product("p-1", { tags: ["linen", "summer"] });
    const firedBefore = updates.length;
    let seenInside: { tags: number; at: number | undefined } | undefined;
    hooks.afterTransactionBody = async (tx) => {
      const tags = await tagCount(tx);
      if (tags === tagsBefore) return;
      // Inside the link write's transaction, before it commits: the new tag AND the bump are both there.
      const [row] = await tx.select({ at: sellableEntities.updatedAt }).from(sellableEntities).where(eq(sellableEntities.id, p1.id));
      seenInside = { tags, at: row?.at.getTime() };
      throw new Error("roll the link transaction back");
    };

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());
    hooks.afterTransactionBody = undefined;

    expect(seenInside?.tags).toBe(tagsBefore + 1);
    expect(seenInside?.at).toBeGreaterThan(p1.at);
    expect(result.ok && result.value.failures?.map((failure) => failure.externalId)).toEqual(["p-1"]);
    // Rolled back together: no tag, no bump.
    expect(await tagCount(db)).toBe(tagsBefore);
    expect((await versions()).get("p-1")).toEqual(p1);
    // afterUpdate is deferred to commit; a rolled-back transaction must not have announced a version.
    expect(updates.slice(firedBefore)).toEqual([]);
  }, 120_000);

  it("(d) storm guard: an unchanged reconcile stays converged 0, moves no product's updated_at, fires nothing", async () => {
    const { service, storeId, versions, updates, db } = await importedStore();
    const before = await versions();
    const links = async () => (await db.select({ n: count() }).from(entityMedia).where(and(eq(entityMedia.role, "primary"))))[0]?.n;
    const mediaBefore = await links();
    await pause();
    const firedBefore = updates.length;

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { converged: result.value.converged, inventoryUpdated: result.value.inventoryUpdated })
      .toEqual({ converged: 0, inventoryUpdated: 0 });
    expect(await versions()).toEqual(before);
    expect(await links()).toBe(mediaBefore);
    expect(updates.slice(firedBefore)).toEqual([]);
  }, 120_000);
});
