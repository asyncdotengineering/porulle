/**
 * One platform organization, many merchants: two stores may sell the same handle.
 *
 * On the 2026-09-24 cold sim run convergence failed with `Slug "pleated-pant-070826" already exists
 * in this organization` — the second merchant's product never converged. Slugs stay unique across
 * the organization, because the storefront resolves `/:idOrSlug` org-wide; the second store's
 * product takes a store-qualified slug instead of failing.
 *
 * The same run failed a merchant on `Key (source_store_id, sku) already exists` — duplicate SKUs
 * inside its own catalogue. That is the merchant's data, so it must come back as that ONE item's
 * failure with the error, never as a page error the caller retries.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap } from "../src/schema.js";

const actor = () => createSystemActor(TEST_ORG_ID);

function product(externalId: string, slug: string, sku: string): ChannelCatalogItem {
  return {
    externalId,
    slug,
    title: `Product ${externalId}`,
    attributes: [{ locale: "en", title: `Product ${externalId}` }],
    status: "active",
    variants: [{ externalId: `${externalId}-v1`, sku, prices: [{ amount: 1000, currency: "LKR" }] }],
  };
}

async function platform() {
  const connector = mockChannelConnector({ catalog: [] });
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
  return { built, service, connect };
}

describe("one platform organization, many stores", () => {
  it("converges two stores' products that share a handle, each at its own resolvable slug", async () => {
    const { built, service, connect } = await platform();
    const first = await connect("atelier.myshopify.com");
    const second = await connect("kelly-felder.myshopify.com");

    const a = await service.convergeCatalogPage(TEST_ORG_ID, first, [product("a-1", "pleated-pant-070826", "PP-1")], actor());
    const b = await service.convergeCatalogPage(TEST_ORG_ID, second, [product("b-1", "pleated-pant-070826", "PP-1")], actor());

    expect(a.ok && a.value.failures).toEqual([]);
    expect(b.ok && b.value.failures).toEqual([]);
    const rows = await built.db.select({ slug: sellableEntities.slug, store: sellableEntities.sourceStoreId })
      .from(sellableEntities).where(eq(sellableEntities.organizationId, TEST_ORG_ID));
    const slugOf = (store: string) => rows.find((row) => row.store === store)?.slug;
    expect(slugOf(first)).toBe("pleated-pant-070826");
    expect(slugOf(second)).toBe("pleated-pant-070826-kelly-felder");

    // Both resolve on the storefront by slug, each to its own store's product.
    for (const store of [first, second]) {
      const slug = slugOf(store);
      if (slug === undefined) throw new Error(`no product for store ${store}`);
      const resolved = await built.kernel.services.catalog.getBySlug(slug, {}, actor());
      expect(resolved.ok && resolved.value.sourceStoreId).toBe(store);
    }
  }, 120_000);

  it("keeps the store-qualified slug when the same product is converged again", async () => {
    const { built, service, connect } = await platform();
    const first = await connect("atelier.myshopify.com");
    const second = await connect("kelly-felder.myshopify.com");
    await service.convergeCatalogPage(TEST_ORG_ID, first, [product("a-1", "wrap-dress", "WD-1")], actor());
    await service.convergeCatalogPage(TEST_ORG_ID, second, [product("b-1", "wrap-dress", "WD-1")], actor());

    // Changed upstream, so it takes the editor path, which compares and rewrites the slug.
    const changed = { ...product("b-1", "wrap-dress", "WD-1"), title: "Wrap dress, renamed" };
    const again = await service.convergeCatalogPage(TEST_ORG_ID, second, [changed], actor());

    expect(again.ok && again.value.failures).toEqual([]);
    const [row] = await built.db.select({ slug: sellableEntities.slug }).from(sellableEntities).where(and(
      eq(sellableEntities.organizationId, TEST_ORG_ID),
      eq(sellableEntities.sourceStoreId, second),
    ));
    expect(row?.slug).toBe("wrap-dress-kelly-felder");
  }, 120_000);

  it("fails only the item whose SKU repeats inside one store, with the error, and the page succeeds", async () => {
    const { service, connect } = await platform();
    const store = await connect("kelly-felder.myshopify.com");

    // Across pages: the fast path.
    await service.convergeCatalogPage(TEST_ORG_ID, store, [product("k-1", "linen-shirt", "DUP-SKU")], actor());
    const fresh = await service.convergeCatalogPage(TEST_ORG_ID, store, [product("k-2", "linen-shirt-2", "DUP-SKU"), product("k-3", "linen-shirt-3", "OK-SKU")], actor());
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.failures).toHaveLength(1);
    expect(fresh.value.failures[0]?.externalId).toBe("k-2");
    expect(fresh.value.failures[0]?.error).toMatch(/sku/i);
    expect(fresh.value.created).toBe(1);

    // An existing product gains a variant whose SKU another product holds: the editor path.
    const base = product("k-3", "linen-shirt-3", "OK-SKU");
    const edited = { ...base, variants: [...base.variants, { externalId: "k-3-v2", sku: "DUP-SKU", prices: [{ amount: 1000, currency: "LKR" }] }] };
    const editor = await service.convergeCatalogPage(TEST_ORG_ID, store, [edited, product("k-4", "linen-shirt-4", "FINE-SKU")], actor());
    expect(editor.ok, editor.ok ? "" : editor.error).toBe(true);
    if (!editor.ok) return;
    expect(editor.value.failures.map((failure) => failure.externalId)).toEqual(["k-3"]);
    expect(editor.value.failures[0]?.error).toMatch(/sku/i);
    expect(editor.value.created).toBe(1);
  }, 120_000);

  it("never recomputes an assigned slug: B keeps its suffix after A's product is deleted, and A re-imports at the bare handle", async () => {
    const { built, service, connect } = await platform();
    const first = await connect("atelier.myshopify.com");
    const second = await connect("kelly-felder.myshopify.com");
    await service.convergeCatalogPage(TEST_ORG_ID, first, [product("a-1", "silk-scarf", "SS-1")], actor());
    await service.convergeCatalogPage(TEST_ORG_ID, second, [product("b-1", "silk-scarf", "SS-1")], actor());
    const slugOf = async (store: string) => (await built.db.select({ slug: sellableEntities.slug }).from(sellableEntities).where(and(
      eq(sellableEntities.organizationId, TEST_ORG_ID),
      eq(sellableEntities.sourceStoreId, store),
    )))[0]?.slug;

    // A's product is deleted outright, which frees the bare handle.
    await built.db.delete(channelEntityMap).where(eq(channelEntityMap.storeId, first));
    await built.db.delete(sellableEntities).where(eq(sellableEntities.sourceStoreId, first));
    const bChanged = { ...product("b-1", "silk-scarf", "SS-1"), title: "Silk scarf, renamed" };
    const bAgain = await service.convergeCatalogPage(TEST_ORG_ID, second, [bChanged], actor());
    expect(bAgain.ok && bAgain.value.failures).toEqual([]);
    expect(await slugOf(second)).toBe("silk-scarf-kelly-felder");

    // A comes back: it takes the free bare handle, and B still does not move.
    const aAgain = await service.convergeCatalogPage(TEST_ORG_ID, first, [product("a-1", "silk-scarf", "SS-1")], actor());
    expect(aAgain.ok && aAgain.value.failures).toEqual([]);
    expect(await slugOf(first)).toBe("silk-scarf");
    await service.convergeCatalogPage(TEST_ORG_ID, second, [{ ...bChanged, title: "Silk scarf, renamed twice" }], actor());
    expect(await slugOf(second)).toBe("silk-scarf-kelly-felder");
  }, 120_000);

  it("gives a third store with the same domain label a slug of its own, and all three resolve", async () => {
    const { built, service, connect } = await platform();
    const stores = [
      await connect("atelier.myshopify.com"),
      await connect("kelly-felder.myshopify.com"),
      await connect("kelly-felder.example.com"),
    ];
    for (const [index, store] of stores.entries()) {
      const result = await service.convergeCatalogPage(TEST_ORG_ID, store, [product(`s${index}-1`, "cargo-skirt", "CS-1")], actor());
      expect(result.ok && result.value.failures).toEqual([]);
    }
    const rows = await built.db.select({ slug: sellableEntities.slug, store: sellableEntities.sourceStoreId })
      .from(sellableEntities).where(eq(sellableEntities.organizationId, TEST_ORG_ID));
    expect(new Set(rows.map((row) => row.slug)).size).toBe(3);
    const third = rows.find((row) => row.store === stores[2]);
    expect(third?.slug).toMatch(/^cargo-skirt-kelly-felder-[a-z0-9]{1,8}$/);
    for (const row of rows) {
      const resolved = await built.kernel.services.catalog.getBySlug(row.slug, {}, actor());
      expect(resolved.ok && resolved.value.sourceStoreId).toBe(row.store);
    }
  }, 120_000);

  // Two merchants onboarding concurrently: both resolve the handle as free, then both create it.
  // The loser's collision is transient, so it must end at the qualified slug, never failed_terminal.
  it("page fast path: two stores converging the same handle at once both land, one at the qualified slug", async () => {
    const { built, service, connect } = await platform();
    const first = await connect("atelier.myshopify.com");
    const second = await connect("kelly-felder.myshopify.com");

    const results = await Promise.all([first, second].map((store, index) =>
      service.convergeCatalogPage(TEST_ORG_ID, store, [product(`r${index}-1`, "boxy-tee", "BT-1")], actor())));

    for (const result of results) expect(result.ok && result.value.failures).toEqual([]);
    const slugs = (await built.db.select({ slug: sellableEntities.slug }).from(sellableEntities)
      .where(eq(sellableEntities.organizationId, TEST_ORG_ID))).map((row) => row.slug).sort();
    expect(slugs.length).toBe(2);
    expect(slugs[0]).toBe("boxy-tee");
    expect(slugs[1]).toMatch(/^boxy-tee-(atelier|kelly-felder)$/);
  }, 120_000);

  it("editor path: two stores reconciling the same handle at once both land, one at the qualified slug", async () => {
    const connector = mockChannelConnector({ catalog: [product("r-1", "boxy-tee", "BT-1")] });
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const connect = async (storeDomain: string): Promise<string> => {
      const response = await built.app.request("http://localhost/api/channels/stores", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain }),
      });
      return (await response.json()).data.id as string;
    };
    const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
    const stores = [await connect("atelier.myshopify.com"), await connect("kelly-felder.myshopify.com")];

    const results = await Promise.all(stores.map((store) => service.reconcile(TEST_ORG_ID, store, actor())));

    for (const result of results) {
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      expect(result.ok && result.value.imported).toBe(1);
    }
    const slugs = (await built.db.select({ slug: sellableEntities.slug }).from(sellableEntities)
      .where(eq(sellableEntities.organizationId, TEST_ORG_ID))).map((row) => row.slug).sort();
    expect(slugs[0]).toBe("boxy-tee");
    expect(slugs[1]).toMatch(/^boxy-tee-(atelier|kelly-felder)$/);
  }, 120_000);
});
