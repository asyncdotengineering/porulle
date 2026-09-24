/**
 * A product the fast path imported must look UNCHANGED to the next reconcile when the store has
 * not changed it.
 *
 * It did not: the host's page consumer re-reads a landed page through its schema, which rebuilds
 * every item in its own key order, while reconcile hashes the adapter's objects in theirs — and the
 * sync hash was `sha256(JSON.stringify(item))`, which hashes key order. Same content, different
 * hash, so reconcile re-converged every freshly imported product, rewrote `updated_at` and storms
 * the index (found on the sim: 25/25 byte-identical products rewritten).
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { sellableEntities, variants } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap } from "../src/schema.js";

const actor = () => createSystemActor(TEST_ORG_ID);
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

/** As the adapter emits it. */
function adapterItem(externalId: string): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: `Product ${externalId}`,
    description: "Linen, relaxed.",
    status: "active",
    tags: ["linen"],
    categories: ["trousers"],
    brand: "Atelier",
    variants: [{ externalId: `${externalId}-v1`, sku: `${externalId}-SKU`, prices: [{ amount: 1000, currency: "LKR" }] }],
  };
}

/** The same content with the keys in the order the host's page consumer rebuilds them. */
function consumerOrdered(item: ChannelCatalogItem): ChannelCatalogItem {
  const variants = item.variants.map((variant) => ({ ...variant }));
  const rebuilt: ChannelCatalogItem = { externalId: item.externalId, slug: item.slug, title: item.title, variants };
  if (item.description !== undefined) rebuilt.description = item.description;
  if (item.tags !== undefined) rebuilt.tags = item.tags;
  if (item.brand !== undefined) rebuilt.brand = item.brand;
  if (item.categories !== undefined) rebuilt.categories = item.categories;
  if (item.status !== undefined) rebuilt.status = item.status;
  return rebuilt;
}

async function fastPathStore(externalIds: string[]) {
  const remote = { catalog: externalIds.map(adapterItem) };
  const connector = mockChannelConnector(remote);
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const updates: string[] = [];
  built.kernel.hooks.append("catalog.afterUpdate", async (args: { result: { id: string } }) => { updates.push(args.result.id); });
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "fast-path-hash.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const page = await service.convergeCatalogPage(TEST_ORG_ID, storeId, remote.catalog.map(consumerOrdered), actor());
  expect(page.ok && page.value.failures).toEqual([]);
  const snapshot = async () => new Map(
    (await built.db.select({ externalId: channelEntityMap.externalId, syncHash: channelEntityMap.syncHash, at: sellableEntities.updatedAt })
      .from(channelEntityMap)
      .innerJoin(sellableEntities, eq(sellableEntities.id, channelEntityMap.entityId))
      .where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity"))))
      .map((row) => [row.externalId, { syncHash: row.syncHash, at: row.at.getTime() }]),
  );
  const variantVersions = async () => new Map(
    (await built.db.select({ id: variants.id, at: variants.updatedAt }).from(variants)
      .innerJoin(sellableEntities, eq(sellableEntities.id, variants.entityId))
      .where(eq(sellableEntities.sourceStoreId, storeId)))
      .map((row) => [row.id, row.at.getTime()]),
  );
  return { service, storeId, built, updates, snapshot, variantVersions };
}

describe("a fast-path-imported product, reconciled unchanged", () => {
  it("writes nothing: converged 0, updated_at and sync_hash unchanged, no afterUpdate", async () => {
    const { service, storeId, updates, snapshot, variantVersions } = await fastPathStore(["p-1", "p-2", "p-3"]);
    const before = await snapshot();
    const variantsBefore = await variantVersions();
    expect(before.size).toBe(3);
    await pause();
    const fired = updates.length;

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(0);
    expect(await variantVersions()).toEqual(variantsBefore);
    expect(updates.slice(fired)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it("migration: a map carrying the old order-sensitive hash converges once WITHOUT touching the entity", async () => {
    const { service, storeId, built, updates, snapshot } = await fastPathStore(["p-1"]);
    await built.db.update(channelEntityMap).set({ syncHash: "legacy-hash-from-before-0.57" })
      .where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.externalId, "p-1")));
    const before = await snapshot();
    await pause();
    const fired = updates.length;

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok).toBe(true);
    const after = await snapshot();
    // The entity is byte-identical upstream: no bump, no hook. Only the map's hash is brought current.
    expect(after.get("p-1")?.at).toBe(before.get("p-1")?.at);
    expect(after.get("p-1")?.syncHash).not.toBe("legacy-hash-from-before-0.57");
    expect(updates.slice(fired)).toEqual([]);
    // …and the next reconcile is a plain no-op.
    const settled = await snapshot();
    const again = await service.reconcile(TEST_ORG_ID, storeId, actor());
    expect(again.ok && again.value.converged).toBe(0);
    expect(await snapshot()).toEqual(settled);
  }, 120_000);
});
