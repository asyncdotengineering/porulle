/**
 * Shopify's `inventory_levels/update` webhook names an INVENTORY ITEM (`inventory_item_id`), not a
 * variant, and the two ids differ. `handleWebhook` looked the channel map up by
 * `data.inventory_item_id`, but maps are keyed by variant id, so every Shopify stock update found no
 * mapping and was silently dropped: the same inventory-item/variant mismatch fixed for polling in
 * 0.57.0.
 *
 * Contract: an imported variant that carries its channel inventory item id
 * (`metadata.inventoryItemId`, which the Shopify adapter emits) is resolved from that id, and its level
 * is set. A webhook for an inventory item no variant carries changes nothing.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { inventoryLevels, sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);

const item: ChannelCatalogItem = {
  externalId: "1000",
  slug: "linen-shirt",
  title: "Linen shirt",
  status: "active",
  variants: [
    { externalId: "50000", sku: "LS-S", metadata: { inventoryItemId: "900000" } },
    { externalId: "50001", sku: "LS-M", metadata: { inventoryItemId: "900001" } },
  ],
};

async function importedStore() {
  const connector = mockChannelConnector({ catalog: [item] });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "inventory-item.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const page = await service.convergeCatalogPage(TEST_ORG_ID, storeId, [item], actor());
  expect(page.ok && page.value.failures).toEqual([]);
  const levels = async () => new Map(
    (await built.db.select({ variantId: inventoryLevels.variantId, qty: inventoryLevels.quantityOnHand }).from(inventoryLevels)
      .innerJoin(sellableEntities, eq(sellableEntities.id, inventoryLevels.entityId))
      .where(eq(sellableEntities.sourceStoreId, storeId))).map((row) => [row.variantId, row.qty]),
  );
  return { service, storeId, levels };
}

describe("a Shopify inventory_levels/update webhook", () => {
  it("sets the level of the variant whose inventory item it names", async () => {
    const { service, storeId, levels } = await importedStore();
    const before = await levels();

    const handled = await service.handleWebhook(TEST_ORG_ID, storeId, { id: "evt-1", type: "inventory_levels/update", data: { inventory_item_id: 900000, location_id: 1, available: 7 } });

    expect(handled.ok).toBe(true);
    const after = await levels();
    // Exactly one variant moved to 7, the one carrying inventory item 900000; the other is unchanged.
    expect([...after.values()].filter((qty) => qty === 7)).toHaveLength(1);
    expect([...before.values()].filter((qty) => qty === 7)).toHaveLength(0);
  });

  it("changes nothing for an inventory item no variant carries", async () => {
    const { service, storeId, levels } = await importedStore();
    const before = await levels();

    await service.handleWebhook(TEST_ORG_ID, storeId, { id: "evt-2", type: "inventory_levels/update", data: { inventory_item_id: 123, location_id: 1, available: 9 } });

    expect(await levels()).toEqual(before);
  });
});
