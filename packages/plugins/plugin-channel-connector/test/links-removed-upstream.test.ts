/**
 * A tag, category or brand the merchant REMOVES in their store must leave the local product too,
 * and version it — otherwise the index keeps a facet the store no longer has, forever. Until this
 * change the converge only ever added links.
 *
 * Only links this store's converge created are removed. A link the merchant added here (by hand,
 * or through another store) is not the store's to take away, even when the store lists — then
 * drops — the same tag.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { brands, categories, entityBrands, entityCategories, entityTags, sellableEntities, tags } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityLinks } from "../src/schema.js";

const actor = () => createSystemActor(TEST_ORG_ID);
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

function product(externalId: string, extra: Partial<ChannelCatalogItem> = {}): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: `Product ${externalId}`,
    status: "active",
    tags: ["linen", "summer"],
    categories: ["trousers", "wide-leg"],
    brand: "Atelier",
    variants: [{ externalId: `${externalId}-v1`, sku: `${externalId}-SKU` }],
    ...extra,
  };
}

async function importedStore() {
  const remote = { catalog: [product("p-1"), product("p-2")] };
  const connector = mockChannelConnector(remote);
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const updates: Array<{ id: string; paths: unknown }> = [];
  built.kernel.hooks.append("catalog.afterUpdate", async (args: { result: { id: string }; context: { context: Record<string, unknown> } }) => {
    updates.push({ id: args.result.id, paths: args.context.context.changedFieldPaths });
  });
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "links-removed.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const imported = await service.reconcile(TEST_ORG_ID, storeId, actor());
  expect(imported.ok && { imported: imported.value.imported, failures: imported.value.failures ?? [] }).toEqual({ imported: 2, failures: [] });

  const entity = async (slug: string) => {
    const [row] = await built.db.select({ id: sellableEntities.id, at: sellableEntities.updatedAt }).from(sellableEntities)
      .where(and(eq(sellableEntities.sourceStoreId, storeId), eq(sellableEntities.slug, slug)));
    if (!row) throw new Error(`${slug} was not imported`);
    return { id: row.id, at: row.at.getTime() };
  };
  const linked = async (entityId: string) => ({
    tags: (await built.db.select({ slug: tags.slug }).from(entityTags).innerJoin(tags, eq(tags.id, entityTags.tagId))
      .where(eq(entityTags.entityId, entityId))).map((row) => row.slug).sort(),
    categories: (await built.db.select({ slug: categories.slug }).from(entityCategories).innerJoin(categories, eq(categories.id, entityCategories.categoryId))
      .where(eq(entityCategories.entityId, entityId))).map((row) => row.slug).sort(),
    brands: (await built.db.select({ slug: brands.slug }).from(entityBrands).innerJoin(brands, eq(brands.id, entityBrands.brandId))
      .where(eq(entityBrands.entityId, entityId))).map((row) => row.slug).sort(),
  });
  /** A tag the merchant adds in the admin, not through the store. */
  const merchantTag = async (entityId: string, slug: string) => {
    const [tag] = await built.db.insert(tags).values({ organizationId: TEST_ORG_ID, slug, displayName: slug }).onConflictDoNothing().returning();
    const tagId = tag?.id ?? (await built.db.select({ id: tags.id }).from(tags).where(and(eq(tags.organizationId, TEST_ORG_ID), eq(tags.slug, slug))))[0]?.id;
    if (!tagId) throw new Error(`tag ${slug} not persisted`);
    await built.db.insert(entityTags).values({ entityId, tagId });
  };
  return { remote, service, storeId, built, updates, entity, linked, merchantTag };
}

describe("links the upstream store dropped", () => {
  it("an upstream tag removed: the local link goes, updated_at moves once, one afterUpdate names tags", async () => {
    const { remote, service, storeId, updates, entity, linked } = await importedStore();
    const before = await entity("p-1");
    const other = await entity("p-2");
    await pause();
    const fired = updates.length;
    remote.catalog[0] = product("p-1", { tags: ["linen"] });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { converged: result.value.converged, failures: result.value.failures ?? [] }).toEqual({ converged: 1, failures: [] });
    expect((await linked(before.id)).tags).toEqual(["linen"]);
    expect((await entity("p-1")).at).toBeGreaterThan(before.at);
    expect(updates.slice(fired)).toEqual([{ id: before.id, paths: ["tags"] }]);
    expect(await entity("p-2")).toEqual(other);
  }, 120_000);

  it("a category dropped and the brand swapped: both change, in ONE afterUpdate", async () => {
    const { remote, service, storeId, updates, entity, linked } = await importedStore();
    const before = await entity("p-1");
    const fired = updates.length;
    remote.catalog[0] = product("p-1", { categories: ["trousers"], brand: "Maison" });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(1);
    expect(await linked(before.id)).toEqual({ tags: ["linen", "summer"], categories: ["trousers"], brands: ["Maison"] });
    expect(updates.slice(fired)).toEqual([{ id: before.id, paths: ["brand", "categories"] }]);
  }, 120_000);

  it("storm guard: an unchanged reconcile removes nothing and moves nothing", async () => {
    const { service, storeId, updates, entity, linked } = await importedStore();
    const before = await entity("p-1");
    const links = await linked(before.id);
    await pause();
    const fired = updates.length;

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(0);
    expect(await linked(before.id)).toEqual(links);
    expect(await entity("p-1")).toEqual(before);
    expect(updates.slice(fired)).toEqual([]);
  }, 120_000);

  it("a tag the merchant added locally survives a reconcile whose store does not list it", async () => {
    const { remote, service, storeId, entity, linked, merchantTag } = await importedStore();
    const p1 = await entity("p-1");
    await merchantTag(p1.id, "staff-pick");
    remote.catalog[0] = product("p-1", { tags: ["linen"] });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(1);
    expect((await linked(p1.id)).tags).toEqual(["linen", "staff-pick"]);
  }, 120_000);

  it("a category the merchant added before the store listed it survives when the store drops it again", async () => {
    const { remote, service, storeId, built, entity, linked } = await importedStore();
    const p1 = await entity("p-1");
    const category = await built.kernel.services.catalog.createCategory({ slug: "sale" }, testAdminActor);
    if (!category.ok) throw new Error(category.error.message);
    const added = await built.kernel.services.catalog.addToCategory(p1.id, category.value.id, testAdminActor);
    expect(added.ok).toBe(true);
    remote.catalog[0] = product("p-1", { categories: ["trousers", "wide-leg", "sale"] });
    await service.reconcile(TEST_ORG_ID, storeId, actor());
    remote.catalog[0] = product("p-1");

    await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect((await linked(p1.id)).categories).toEqual(["sale", "trousers", "wide-leg"]);
  }, 120_000);

  it("coincident link: a tag the merchant added AND the store lists survives while the store lists it", async () => {
    const { remote, service, storeId, entity, linked, merchantTag } = await importedStore();
    const p1 = await entity("p-1");
    await merchantTag(p1.id, "resort");
    remote.catalog[0] = product("p-1", { tags: ["linen", "summer", "resort"] });

    await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect((await linked(p1.id)).tags).toEqual(["linen", "resort", "summer"]);
  }, 120_000);

  it("a product imported before provenance existed: its first converge claims what the store lists now, keeps a stale extra link, and later removals work", async () => {
    const { remote, service, storeId, built, entity, linked, merchantTag } = await importedStore();
    const p1 = await entity("p-1");
    // Pre-release state: no provenance on record, and a link upstream had ALREADY dropped (stale).
    await built.db.delete(channelEntityLinks).where(eq(channelEntityLinks.entityId, p1.id));
    await merchantTag(p1.id, "stale-drop");

    await service.reconcile(TEST_ORG_ID, storeId, actor());
    // Claimed, not deleted: the stale link was never the store's on record.
    expect((await linked(p1.id)).tags).toEqual(["linen", "stale-drop", "summer"]);
    const claimed = (await built.db.select({ kind: channelEntityLinks.kind }).from(channelEntityLinks)
      .where(and(eq(channelEntityLinks.entityId, p1.id), eq(channelEntityLinks.storeId, storeId)))).map((row) => row.kind).sort();
    expect(claimed).toEqual(["brand", "category", "category", "tag", "tag"]);

    remote.catalog[0] = product("p-1", { tags: ["linen"] });
    await service.reconcile(TEST_ORG_ID, storeId, actor());
    expect((await linked(p1.id)).tags).toEqual(["linen", "stale-drop"]);
  }, 120_000);

  it("a product imported by the page fast path is on record from import: the store's first drop removes the link", async () => {
    const { service, storeId, built, linked } = await importedStore();
    const page = await service.convergeCatalogPage(TEST_ORG_ID, storeId, [product("page-1")], actor());
    expect(page.ok).toBe(true);
    const [row] = await built.db.select({ id: sellableEntities.id }).from(sellableEntities)
      .where(and(eq(sellableEntities.sourceStoreId, storeId), eq(sellableEntities.slug, "page-1")));
    if (!row) throw new Error("page-1 was not imported");

    const dropped = await service.convergeCatalogPage(TEST_ORG_ID, storeId, [product("page-1", { tags: ["linen"], categories: ["trousers"] })], actor());

    expect(dropped.ok).toBe(true);
    expect(await linked(row.id)).toEqual({ tags: ["linen"], categories: ["trousers"], brands: ["Atelier"] });
  }, 120_000);
});
