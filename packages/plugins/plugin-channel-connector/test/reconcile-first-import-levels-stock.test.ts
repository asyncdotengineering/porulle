/**
 * A reconcile that imports products for the first time also levels their stock and keeps each
 * variant's provider facts (`metadata`).
 *
 * Written before the fix: the reconcile read the store's mappings BEFORE converging, so on a first
 * import the stock pass walked an empty list and every new product sat with no inventory level until
 * the next reconcile. Vacuity guard: the catalogue's variant carries a non-zero, non-default quantity
 * (7), so a level that exists for any other reason cannot satisfy the row.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor } from "@porulle/core";
import type { ChannelCatalogItem } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core/testing";
import { and, eq } from "@porulle/core/drizzle";
import { inventoryLevels, variants } from "@porulle/core/schema";
import { ChannelConnectorService, channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { channelEntityMap } from "../src/schema.js";

const item: ChannelCatalogItem = {
  externalId: "first-import-product",
  slug: "first-import-product",
  title: "First Import",
  status: "active",
  variants: [{ externalId: "first-import-variant", sku: "FIRST-1", prices: [{ currency: "LKR", amount: 1000 }], metadata: { inventoryItemId: "inventory-item-77", weightGrams: 250 } }],
};

describe("reconcile on a first import", () => {
  it("levels the stock of the products it just imported", async () => {
    const connector = mockChannelConnector({ catalog: [item], inventory: [{ externalId: "first-import-variant", available: 7 }] });
    const options = { connectors: [connector] };
    const built = await createPluginTestApp(channelConnectorPlugin(options));
    const connected = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "first-import.example" }),
    });
    const storeId = (await connected.json()).data.id as string;
    const orgId = testAdminActor.organizationId ?? "";
    const service = new ChannelConnectorService(built.db, built.kernel.services, options);
    const report = await service.reconcile(orgId, storeId, createSystemActor(orgId));
    expect(report.ok).toBe(true);
    const [variant] = await built.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "variant")));
    expect(variant?.variantId).toBeTruthy();
    const levels = await built.db.select().from(inventoryLevels).where(eq(inventoryLevels.variantId, variant?.variantId ?? ""));
    expect(levels.map((level) => level.quantityOnHand)).toEqual([7]);
    // The provider's per-variant facts land too: a stock webhook names the inventory item, and
    // shipping prices by the weight.
    const [row] = await built.db.select({ metadata: variants.metadata }).from(variants).where(eq(variants.id, variant?.variantId ?? ""));
    expect(row?.metadata).toMatchObject({ inventoryItemId: "inventory-item-77", weightGrams: 250 });
  }, 120_000);
});
