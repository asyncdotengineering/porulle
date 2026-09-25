/**
 * A product whose own variants repeat a SKU is normalised ONCE, at the connector's item intake, so
 * converge and reconcile read the same variants.
 *
 * The host normalised those SKUs itself, before `convergeCatalogPage`, and reconcile read the raw
 * upstream items. `applyUpstreamVariantIdentity` then compared the stored `GF-DUP-1-<externalId>`
 * with upstream `GF-DUP-1`, planned a write that collided with the sibling holding `GF-DUP-1`, and
 * recorded an open `variants.sku` conflict on EVERY reconcile.
 *
 * The rule, unchanged from the host's: per item, group variants by SKU; the smallest externalId
 * (string order) keeps it, every other variant becomes `${sku}-${externalId}`. Deterministic and
 * independent of upstream order.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { sellableEntities, variants } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector, withDistinctVariantSkus } from "../src/index.js";
import { channelCatalogConflicts } from "../src/schema.js";

const actor = () => createSystemActor(TEST_ORG_ID);
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

function duplicated(order: "forward" | "reversed"): ChannelCatalogItem {
  const variantsInOrder = [
    { externalId: "v-b", sku: "GF-DUP-1", prices: [{ amount: 1000, currency: "LKR" }] },
    { externalId: "v-a", sku: "GF-DUP-1", prices: [{ amount: 1000, currency: "LKR" }] },
    { externalId: "v-c", sku: "GF-DUP-1", prices: [{ amount: 1000, currency: "LKR" }] },
  ];
  return {
    externalId: "p-dup",
    slug: "p-dup",
    title: "Duplicated SKU product",
    status: "active",
    variants: order === "forward" ? variantsInOrder : [...variantsInOrder].reverse(),
  };
}

async function importedStore() {
  const remote = { catalog: [duplicated("forward")] };
  const connector = mockChannelConnector(remote);
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "dup-sku.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  // The host hands the RAW upstream item, as it will once its own copy of the rule is deleted.
  const page = await service.convergeCatalogPage(TEST_ORG_ID, storeId, [duplicated("forward")], actor());
  expect(page.ok && page.value.failures).toEqual([]);
  const skus = async () => new Map(
    (await built.db.select({ sku: variants.sku, at: variants.updatedAt }).from(variants)
      .innerJoin(sellableEntities, eq(sellableEntities.id, variants.entityId))
      .where(eq(sellableEntities.sourceStoreId, storeId)))
      .map((row) => [row.sku, row.at.getTime()]),
  );
  const conflicts = async () => (await built.db.select().from(channelCatalogConflicts).where(eq(channelCatalogConflicts.storeId, storeId))).length;
  return { remote, service, storeId, skus, conflicts };
}

describe("in-product duplicate SKUs at the connector intake", () => {
  it("the keeper is the smallest externalId in STRING order, as the host rule has it: \"10\" keeps before \"9\"", () => {
    const item: ChannelCatalogItem = { externalId: "p-mixed", slug: "p-mixed", title: "Mixed ids", variants: [
      { externalId: "9", sku: "MIX" },
      { externalId: "10", sku: "MIX" },
      { externalId: "100", sku: "OTHER" },
      { externalId: "11" },
    ] };
    const skus = (value: ChannelCatalogItem) => Object.fromEntries(value.variants.map((variant) => [variant.externalId, variant.sku]));

    expect(skus(withDistinctVariantSkus(item))).toEqual({ "9": "MIX-9", "10": "MIX", "100": "OTHER", "11": undefined });
    expect(skus(withDistinctVariantSkus({ ...item, variants: [...item.variants].reverse() }))).toEqual({ "9": "MIX-9", "10": "MIX", "100": "OTHER", "11": undefined });
    expect(withDistinctVariantSkus(withDistinctVariantSkus(item))).toEqual(withDistinctVariantSkus(item));
  });

  it("a raw item imports all three variants: the smallest externalId keeps the SKU, the others are suffixed", async () => {
    const { skus } = await importedStore();
    expect([...(await skus()).keys()].sort()).toEqual(["GF-DUP-1", "GF-DUP-1-v-b", "GF-DUP-1-v-c"]);
  }, 120_000);

  it("reconcile against the same upstream item writes no variant and records no conflict", async () => {
    const { service, storeId, skus, conflicts } = await importedStore();
    const before = await skus();
    await pause();

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok).toBe(true);
    expect(await skus()).toEqual(before);
    expect(await conflicts()).toBe(0);
  }, 120_000);

  it("reconcile with the upstream variants REVERSED writes no variant and records no conflict", async () => {
    const { remote, service, storeId, skus, conflicts } = await importedStore();
    const before = await skus();
    remote.catalog.splice(0, 1, duplicated("reversed"));
    await pause();

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok).toBe(true);
    expect(await skus()).toEqual(before);
    expect(await conflicts()).toBe(0);
  }, 120_000);

  it("fetchCatalogPage, the host's page source, hands out the normalised item", async () => {
    const { service, storeId } = await importedStore();

    const page = await service.fetchCatalogPage(TEST_ORG_ID, storeId, null);

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const item = page.value.items.find((candidate) => candidate.externalId === "p-dup");
    expect(Object.fromEntries((item?.variants ?? []).map((variant) => [variant.externalId, variant.sku])))
      .toEqual({ "v-a": "GF-DUP-1", "v-b": "GF-DUP-1-v-b", "v-c": "GF-DUP-1-v-c" });
  }, 120_000);
});
