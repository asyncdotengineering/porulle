/**
 * A converge that changes an entity's taxonomy LINKS must version the entity, and a converge that
 * changes nothing must version nothing.
 *
 * Tags, categories and brand are indexed search facets. Category and brand links go through the
 * catalog service, which versions them; the converge writes tag links itself, so a tag-only
 * upstream change left `sellable_entities.updated_at` where it was and the index kept the old tags.
 *
 * The storm guard is the other half: an unchanged reconcile must stay converged 0 and move no
 * entity's `updated_at` — a bump on every reconcile would re-project the whole catalogue.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

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
    variants: [{ externalId: `${externalId}-v1`, sku: `${externalId}-SKU`, prices: [{ amount: 1000, currency: "LKR" }] }],
    ...extra,
  };
}

async function importedStore() {
  const remote = { catalog: [product("p-1"), product("p-2")] };
  const connector = mockChannelConnector(remote);
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "links-versioned.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const imported = await service.reconcile(TEST_ORG_ID, storeId, actor());
  expect(imported.ok && imported.value.imported).toBe(2);
  const versions = async () => new Map(
    (await built.db.select({ slug: sellableEntities.slug, at: sellableEntities.updatedAt }).from(sellableEntities)
      .where(eq(sellableEntities.sourceStoreId, storeId)))
      .map((row) => [row.slug, row.at.getTime()]),
  );
  return { remote, service, storeId, versions };
}

describe("taxonomy link changes on converge", () => {
  it("a tag-only upstream change moves that product's updated_at, and only that product's", async () => {
    const { remote, service, storeId, versions } = await importedStore();
    const before = await versions();
    await pause();
    remote.catalog[0] = product("p-1", { tags: ["linen", "summer"] });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(1);
    const after = await versions();
    expect(after.get("p-1")).toBeGreaterThan(before.get("p-1") ?? Infinity);
    expect(after.get("p-2")).toBe(before.get("p-2"));
  }, 120_000);

  it("a category-only upstream change moves that product's updated_at", async () => {
    const { remote, service, storeId, versions } = await importedStore();
    const before = await versions();
    await pause();
    remote.catalog[1] = product("p-2", { categories: ["trousers", "wide-leg"] });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(1);
    expect((await versions()).get("p-2")).toBeGreaterThan(before.get("p-2") ?? Infinity);
  }, 120_000);

  it("storm guard: an unchanged reconcile stays converged 0 and moves no product's updated_at", async () => {
    const { service, storeId, versions } = await importedStore();
    const before = await versions();
    await pause();

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { converged: result.value.converged, inventoryUpdated: result.value.inventoryUpdated })
      .toEqual({ converged: 0, inventoryUpdated: 0 });
    expect(await versions()).toEqual(before);
  }, 120_000);
});
