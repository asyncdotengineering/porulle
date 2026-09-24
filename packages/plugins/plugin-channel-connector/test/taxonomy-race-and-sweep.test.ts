/**
 * Two stores in one platform organization converging at the same time.
 *
 * On the sim's after5 run (2026-09-24, @porulle 0.49.0) a delayed reconcile ERRORED with
 * `Category with slug belt already exists.`: two stores' converges each saw "belt" missing from
 * their taxonomy snapshot, both created it, and the loser's conflict failed the WHOLE reconcile.
 * A category or brand another writer created first is the one to link to, never an error.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { brands, categories, entityBrands, entityCategories } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);

const belt = (externalId: string): ChannelCatalogItem => ({
  externalId,
  slug: `belt-${externalId}`,
  title: `Belt ${externalId}`,
  attributes: [{ locale: "en", title: `Belt ${externalId}` }],
  status: "active",
  categories: ["belt"],
  brand: "Atelier",
  variants: [{ externalId: `${externalId}-v1`, sku: `${externalId}-SKU`, prices: [{ amount: 1000, currency: "LKR" }] }],
});

async function twoStores(catalog: ChannelCatalogItem[]) {
  const connector = mockChannelConnector({ catalog });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const connect = async (storeDomain: string): Promise<string> => {
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).data.id as string;
  };
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const stores = [await connect("atelier.myshopify.com"), await connect("kelly-felder.myshopify.com")];
  return { built, service, stores };
}

async function taxonomyRows(built: Awaited<ReturnType<typeof twoStores>>["built"]) {
  const categoryRows = await built.db.select({ id: categories.id }).from(categories).where(and(eq(categories.organizationId, TEST_ORG_ID), eq(categories.slug, "belt")));
  const brandRows = await built.db.select({ id: brands.id }).from(brands).where(and(eq(brands.organizationId, TEST_ORG_ID), eq(brands.slug, "Atelier")));
  const categoryLinks = await built.db.select({ categoryId: entityCategories.categoryId }).from(entityCategories);
  const brandLinks = await built.db.select({ brandId: entityBrands.brandId }).from(entityBrands);
  return { categoryRows, brandRows, categoryLinks, brandLinks };
}

describe("two stores converging the same category and brand at once", () => {
  it("editor path (reconcile): both complete, and both products link to the one category and one brand", async () => {
    const { built, service, stores } = await twoStores([belt("b-1")]);

    const results = await Promise.all(stores.map((store) => service.reconcile(TEST_ORG_ID, store, actor())));

    for (const result of results) {
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      expect(result.ok && result.value.imported).toBe(1);
    }
    const rows = await taxonomyRows(built);
    expect(rows.categoryRows).toHaveLength(1);
    expect(rows.brandRows).toHaveLength(1);
    expect(rows.categoryLinks.filter((link) => link.categoryId === rows.categoryRows[0]?.id)).toHaveLength(2);
    expect(rows.brandLinks.filter((link) => link.brandId === rows.brandRows[0]?.id)).toHaveLength(2);
  }, 120_000);

  it("page fast path: both pages land every product, linked to the one category and one brand", async () => {
    const { built, service, stores } = await twoStores([]);

    const results = await Promise.all(stores.map((store, index) =>
      service.convergeCatalogPage(TEST_ORG_ID, store, [belt(`p${index}`)], actor())));

    for (const result of results) {
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      expect(result.ok && result.value.failures).toEqual([]);
    }
    const rows = await taxonomyRows(built);
    expect(rows.categoryRows).toHaveLength(1);
    expect(rows.brandRows).toHaveLength(1);
    expect(rows.categoryLinks.filter((link) => link.categoryId === rows.categoryRows[0]?.id)).toHaveLength(2);
  }, 120_000);
});
