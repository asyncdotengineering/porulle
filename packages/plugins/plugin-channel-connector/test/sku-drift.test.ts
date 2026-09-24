/**
 * An upstream SKU or barcode change on a variant the store already maps must land locally.
 *
 * Until this, `upsertVariants` resolved an already-mapped variant and never wrote its sku or
 * barcode, so an upstream SKU change was dropped without a trace and the local variant kept the old
 * SKU for good — and order fan-out to the merchant keys on SKU.
 *
 * SKU is unique per source store, so the hard cases are swaps: two variants exchanging SKUs. Inside
 * one converge batch they must both land; a real clash with a variant whose upstream did NOT change
 * is that one item's failure, never a page error and never silent.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type ChannelCatalogVariant } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { sellableAttributes, sellableEntities, sellableEntityRevisions, variants } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelCatalogConflictEvents, channelCatalogConflicts, channelEntityMap } from "../src/schema.js";

const actor = () => createSystemActor(TEST_ORG_ID);

const variant = (externalId: string, sku: string, size: string, barcode?: string): ChannelCatalogVariant => ({
  externalId,
  sku,
  optionValues: { size },
  prices: [{ amount: 1000, currency: "LKR" }],
  ...(barcode !== undefined ? { barcode } : {}),
});

function product(externalId: string, productVariants: ChannelCatalogVariant[]): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: `Product ${externalId}`,
    attributes: [{ locale: "en", title: `Product ${externalId}` }],
    status: "active",
    options: [{
      name: "size",
      displayName: "Size",
      sortOrder: 0,
      values: [{ value: "s", displayValue: "S", sortOrder: 0 }, { value: "m", displayValue: "M", sortOrder: 1 }],
    }],
    variants: productVariants,
  };
}

/** Two products: p1 has two variants (A1, B1), p2 has one (C1). */
const baseline = (): ChannelCatalogItem[] => [
  product("p1", [variant("p1-a", "A1", "s", "0001"), variant("p1-b", "B1", "m", "0002")]),
  product("p2", [variant("p2-a", "C1", "s", "0003")]),
];

async function importedStore() {
  const remote = { catalog: baseline() };
  const connector = mockChannelConnector(remote);
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "sku-drift.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const imported = await service.reconcile(TEST_ORG_ID, storeId, actor());
  expect(imported.ok && imported.value.imported).toBe(2);

  /** The local variant mapped to an upstream variant externalId. */
  const local = async (externalId: string) => {
    const [row] = await built.db.select({ id: variants.id, sku: variants.sku, barcode: variants.barcode, updatedAt: variants.updatedAt, entityId: variants.entityId })
      .from(channelEntityMap)
      .innerJoin(variants, eq(variants.id, channelEntityMap.variantId))
      .where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "variant"), eq(channelEntityMap.externalId, externalId)));
    if (!row) throw new Error(`no local variant mapped to ${externalId}`);
    return row;
  };
  const reconcile = () => service.reconcile(TEST_ORG_ID, storeId, actor());
  return { built, remote, storeId, local, reconcile, service };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("upstream sku and barcode changes on already-mapped variants", () => {
  it("(a) writes an upstream SKU change and moves updated_at", async () => {
    const { remote, local, reconcile } = await importedStore();
    const before = await local("p1-a");
    await pause();
    remote.catalog[0] = product("p1", [variant("p1-a", "A1-NEW", "s", "0001"), variant("p1-b", "B1", "m", "0002")]);

    const result = await reconcile();

    expect(result.ok && result.value.failures).toBeUndefined();
    const after = await local("p1-a");
    expect(after.sku).toBe("A1-NEW");
    expect(after.id).toBe(before.id);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(result.ok && result.value.converged).toBe(1);
  }, 120_000);

  it("(b) writes an upstream barcode change", async () => {
    const { remote, local, reconcile } = await importedStore();
    remote.catalog[1] = product("p2", [variant("p2-a", "C1", "s", "9999")]);

    const result = await reconcile();

    expect(result.ok && result.value.failures).toBeUndefined();
    expect((await local("p2-a")).barcode).toBe("9999");
  }, 120_000);

  it("(c) lands a swap of SKUs between two variants of one product", async () => {
    const { remote, local, reconcile } = await importedStore();
    remote.catalog[0] = product("p1", [variant("p1-a", "B1", "s", "0001"), variant("p1-b", "A1", "m", "0002")]);

    const result = await reconcile();

    expect(result.ok && result.value.failures).toBeUndefined();
    expect([(await local("p1-a")).sku, (await local("p1-b")).sku]).toEqual(["B1", "A1"]);
  }, 120_000);

  it("(d) lands a swap of SKUs between variants of two products in one reconcile", async () => {
    const { remote, local, reconcile } = await importedStore();
    remote.catalog[0] = product("p1", [variant("p1-a", "C1", "s", "0001"), variant("p1-b", "B1", "m", "0002")]);
    remote.catalog[1] = product("p2", [variant("p2-a", "A1", "s", "0003")]);

    const result = await reconcile();

    expect(result.ok && result.value.failures).toBeUndefined();
    expect([(await local("p1-a")).sku, (await local("p2-a")).sku]).toEqual(["C1", "A1"]);
  }, 120_000);

  it("(e) a clash with an unchanged variant keeps that SKU, records a conflict naming the holder, and converges everything else", async () => {
    const { built, remote, storeId, local, reconcile } = await importedStore();
    // p2-a wants B1, but p1-b still has B1 upstream: a real duplicate in the store's data. The same
    // payload renames p2, which must still land.
    remote.catalog[1] = { ...product("p2", [variant("p2-a", "B1", "s", "0004")]), title: "Renamed p2", attributes: [{ locale: "en", title: "Renamed p2" }] };

    const result = await reconcile();

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.failures).toBeUndefined();
    expect(result.value.openConflicts).toBe(1);
    expect((await local("p2-a")).sku).toBe("C1");
    expect((await local("p2-a")).barcode).toBe("0004");
    expect((await local("p1-b")).sku).toBe("B1");
    const [conflict] = await built.db.select().from(channelCatalogConflicts).where(and(eq(channelCatalogConflicts.storeId, storeId), eq(channelCatalogConflicts.state, "open")));
    expect(conflict?.fieldPath).toBe("variants.sku");
    expect(conflict?.storeValue).toEqual({ "p2-a": "B1" });
    expect(conflict?.platformValue).toEqual({ "p2-a": { sku: "C1", heldByVariantId: (await local("p1-b")).id } });
    const [title] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, (await local("p2-a")).entityId));
    expect(title?.title).toBe("Renamed p2");
  }, 120_000);

  it("(h) a swap split across two import pages records conflicts, and the next reconcile lands both and clears them", async () => {
    const { built, remote, storeId, local, reconcile, service } = await importedStore();
    const p1 = product("p1", [variant("p1-a", "C1", "s", "0001"), variant("p1-b", "B1", "m", "0002")]);
    const p2 = product("p2", [variant("p2-a", "A1", "s", "0003")]);
    remote.catalog[0] = p1;
    remote.catalog[1] = p2;

    const page1 = await service.convergeCatalogPage(TEST_ORG_ID, storeId, [p1], actor());
    const page2 = await service.convergeCatalogPage(TEST_ORG_ID, storeId, [p2], actor());
    expect(page1.ok && page1.value.failures).toEqual([]);
    expect(page2.ok && page2.value.failures).toEqual([]);
    const openAfterPages = await built.db.select().from(channelCatalogConflicts).where(and(eq(channelCatalogConflicts.storeId, storeId), eq(channelCatalogConflicts.state, "open")));
    expect(openAfterPages.length).toBeGreaterThanOrEqual(1);

    const healed = await reconcile();

    expect(healed.ok && healed.value.failures).toBeUndefined();
    expect([(await local("p1-a")).sku, (await local("p2-a")).sku]).toEqual(["C1", "A1"]);
    expect(healed.ok && healed.value.openConflicts).toBe(0);
    const stillOpen = await built.db.select().from(channelCatalogConflicts).where(and(eq(channelCatalogConflicts.storeId, storeId), eq(channelCatalogConflicts.state, "open")));
    expect(stillOpen).toEqual([]);
  }, 120_000);

  it("(i) a permanent duplicate stays quiet: later reconciles write nothing, reuse the one open conflict, and converge 0", async () => {
    const { built, remote, storeId, local, reconcile } = await importedStore();
    remote.catalog[1] = { ...product("p2", [variant("p2-a", "B1", "s", "0004")]), title: "Renamed p2", attributes: [{ locale: "en", title: "Renamed p2" }] };
    const first = await reconcile();
    expect(first.ok && first.value.openConflicts).toBe(1);
    const entityId = (await local("p2-a")).entityId;
    const snapshot = async () => ({
      variantUpdatedAt: (await built.db.select({ id: variants.id, at: variants.updatedAt }).from(variants).where(eq(variants.sourceStoreId, storeId)))
        .map((row) => `${row.id}@${row.at.toISOString()}`).sort(),
      entityUpdatedAt: (await built.db.select({ at: sellableEntities.updatedAt }).from(sellableEntities).where(eq(sellableEntities.id, entityId)))[0]?.at.toISOString(),
      revisions: (await built.db.select({ id: sellableEntityRevisions.id }).from(sellableEntityRevisions).where(eq(sellableEntityRevisions.entityId, entityId))).length,
      conflicts: (await built.db.select({ id: channelCatalogConflicts.id }).from(channelCatalogConflicts).where(eq(channelCatalogConflicts.storeId, storeId))).length,
      events: (await built.db.select({ id: channelCatalogConflictEvents.id }).from(channelCatalogConflictEvents)).length,
    });
    const settled = await snapshot();
    let catalogUpdates = 0;
    built.kernel.hooks.append("catalog.afterUpdate", async () => { catalogUpdates += 1; });

    for (const pass of [2, 3]) {
      await pause();
      const result = await reconcile();
      expect(result.ok && { pass, converged: result.value.converged, openConflicts: result.value.openConflicts, failures: result.value.failures })
        .toEqual({ pass, converged: 0, openConflicts: 1, failures: undefined });
    }

    expect(await snapshot()).toEqual(settled);
    expect(catalogUpdates).toBe(0);
    expect((await local("p2-a")).sku).toBe("C1");
  }, 120_000);

  it("(f) does not overwrite a platform-owned SKU", async () => {
    const { built, remote, storeId, local, reconcile } = await importedStore();
    const owned = await built.kernel.services.catalog.setFieldOwner((await local("p1-a")).entityId, "variants.sku", storeId, "platform", testAdminActor);
    expect(owned.ok).toBe(true);
    remote.catalog[0] = product("p1", [variant("p1-a", "A1-NEW", "s", "0001"), variant("p1-b", "B1", "m", "0002")]);

    await reconcile();

    expect((await local("p1-a")).sku).toBe("A1");
  }, 120_000);

  it("(g) control: an unchanged reconcile writes no sku and does not move updated_at", async () => {
    const { local, reconcile } = await importedStore();
    const before = await local("p1-a");
    await pause();

    const result = await reconcile();

    expect(result.ok && { converged: result.value.converged, failures: result.value.failures }).toEqual({ converged: 0, failures: undefined });
    const after = await local("p1-a");
    expect(after.sku).toBe("A1");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  }, 120_000);
});
