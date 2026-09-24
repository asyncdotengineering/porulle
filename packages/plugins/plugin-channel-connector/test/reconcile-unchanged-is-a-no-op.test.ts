/**
 * A reconcile over a catalogue nobody changed must change nothing.
 *
 * Measured on the sim on 2026-09-24, 52 minutes after a gflock-100 import had settled, one
 * `channel/reconcile` step reported
 *
 *   {"imported":0,"converged":96,"archived":0,"inventoryUpdated":1243,"openConflicts":0,"driftAlert":true}
 *
 * over 96 products the store had not touched. Every one of the 1,243 level writes fired
 * `inventory.afterAdjust`, and the consumer's projection hook turned each into a pending
 * re-projection. `driftAlert` is derived from `imported + converged + archived`, so a reconcile
 * that miscounts unchanged products as converged also raises a false drift alarm.
 *
 * The rows import page by page, level the inventory, and then reconcile the same catalogue.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { inventoryLevels, inventoryMovements } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap } from "../src/schema.js";

const actor = () => createSystemActor(TEST_ORG_ID);

function defaultRemote(): Remote {
  const catalog = ["gf-001", "gf-002", "gf-003"].map(product);
  return {
    catalog,
    inventory: catalog.flatMap((item) => item.variants.map((variant, index) => ({ externalId: variant.externalId, available: index + 2 }))),
  };
}

function product(externalId: string): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: `Product ${externalId}`,
    attributes: [{ locale: "en", title: `Product ${externalId}` }],
    options: [{
      name: "size",
      displayName: "Size",
      sortOrder: 0,
      values: [{ value: "s", displayValue: "S", sortOrder: 0 }, { value: "m", displayValue: "M", sortOrder: 1 }],
    }],
    status: "active",
    variants: ["s", "m"].map((size) => ({
      externalId: `${externalId}-${size}`,
      sku: `${externalId}-${size}`,
      optionValues: { size },
      prices: [{ amount: 1000, currency: "LKR" }],
    })),
  };
}

type Remote = { catalog: ChannelCatalogItem[]; inventory: { externalId: string; available: number }[] };

/** The mock connector reads `remote` on every call, so a row can change the store after import. */
async function importedStore(remote: Remote = defaultRemote()) {
  const connector = mockChannelConnector(remote);
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "reconcile-noop.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });

  for (let guard = 0; ; guard += 1) {
    if (guard === 20) throw new Error("the catalog import did not exhaust");
    const page = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 2 });
    if (!page.ok) throw new Error(page.error);
    if (page.value.exhausted) break;
  }
  for (let guard = 0; ; guard += 1) {
    if (guard === 20) throw new Error("the inventory sync did not exhaust");
    const synced = await service.syncInventory(TEST_ORG_ID, storeId, actor());
    if (!synced.ok) throw new Error(synced.error);
    if (synced.value.exhausted === true) break;
  }
  return { built, service, storeId };
}

describe("reconcile over an unchanged catalogue", () => {
  it("reports nothing converged, no level written, no drift, and fires no inventory.afterAdjust", async () => {
    const { built, service, storeId } = await importedStore();
    let adjusts = 0;
    built.kernel.hooks.append("inventory.afterAdjust", async () => { adjusts += 1; });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result).toEqual({
      ok: true,
      value: { imported: 0, converged: 0, archived: 0, inventoryUpdated: 0, openConflicts: 0, driftAlert: false },
    });
    expect(adjusts).toBe(0);
  }, 120_000);

  it("does not count a product converged when only its stored hash moved and nothing about it changed", async () => {
    const { built, service, storeId } = await importedStore();
    // A failed outbound push blanks the hash (`recordOutboundPush`), and so would any change to how
    // an item serialises. Either way the remote product and the local one are still identical.
    await built.db.update(channelEntityMap).set({ syncHash: "" }).where(and(
      eq(channelEntityMap.storeId, storeId),
      eq(channelEntityMap.kind, "entity"),
    ));

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { converged: result.value.converged, driftAlert: result.value.driftAlert }).toEqual({ converged: 0, driftAlert: false });
  }, 120_000);

  it("setAbsolute to the quantity already on hand writes no movement and fires no inventory.afterAdjust", async () => {
    const { built } = await importedStore();
    const [level] = await built.db.select().from(inventoryLevels).where(eq(inventoryLevels.organizationId, TEST_ORG_ID)).limit(1);
    if (!level) throw new Error("the import left no inventory level");
    const movementsBefore = (await built.db.select({ id: inventoryMovements.id }).from(inventoryMovements)).length;
    let adjusts = 0;
    built.kernel.hooks.append("inventory.afterAdjust", async () => { adjusts += 1; });

    const result = await built.kernel.services.inventory.setAbsolute({
      entityId: level.entityId,
      ...(level.variantId !== null ? { variantId: level.variantId } : {}),
      warehouseId: level.warehouseId,
      quantity: level.quantityOnHand,
    }, actor());

    expect(result.ok && result.value.quantityOnHand).toBe(level.quantityOnHand);
    expect(adjusts).toBe(0);
    expect((await built.db.select({ id: inventoryMovements.id }).from(inventoryMovements)).length).toBe(movementsBefore);
  }, 120_000);

  it("control: setAbsolute to a different quantity still writes one movement and fires inventory.afterAdjust once", async () => {
    const { built } = await importedStore();
    const [level] = await built.db.select().from(inventoryLevels).where(eq(inventoryLevels.organizationId, TEST_ORG_ID)).limit(1);
    if (!level) throw new Error("the import left no inventory level");
    const movementsBefore = (await built.db.select({ id: inventoryMovements.id }).from(inventoryMovements)).length;
    let adjusts = 0;
    built.kernel.hooks.append("inventory.afterAdjust", async () => { adjusts += 1; });

    const result = await built.kernel.services.inventory.setAbsolute({
      entityId: level.entityId,
      ...(level.variantId !== null ? { variantId: level.variantId } : {}),
      warehouseId: level.warehouseId,
      quantity: level.quantityOnHand + 5,
    }, actor());

    expect(result.ok && result.value.quantityOnHand).toBe(level.quantityOnHand + 5);
    expect(adjusts).toBe(1);
    expect((await built.db.select({ id: inventoryMovements.id }).from(inventoryMovements)).length).toBe(movementsBefore + 1);
  }, 120_000);

  it("control: a product that really changed still counts converged, and a moved level still counts updated", async () => {
    const catalog = ["gf-101", "gf-102"].map(product);
    const inventory = catalog.flatMap((item) => item.variants.map((variant) => ({ externalId: variant.externalId, available: 4 })));
    const { built, service, storeId } = await importedStore({ catalog, inventory });
    catalog[0] = { ...product("gf-101"), title: "Renamed upstream", attributes: [{ locale: "en", title: "Renamed upstream" }] };
    inventory[0] = { externalId: inventory[0]!.externalId, available: 9 };
    let adjusts = 0;
    built.kernel.hooks.append("inventory.afterAdjust", async () => { adjusts += 1; });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { converged: result.value.converged, inventoryUpdated: result.value.inventoryUpdated }).toEqual({ converged: 1, inventoryUpdated: 1 });
    expect(adjusts).toBe(1);
  }, 120_000);

  it("a store reporting negative stock is level-set once, not re-announced at every reconcile", async () => {
    const remote = defaultRemote();
    remote.inventory[0] = { externalId: remote.inventory[0]!.externalId, available: -3 };
    const { built, service, storeId } = await importedStore(remote);
    let adjusts = 0;
    built.kernel.hooks.append("inventory.afterAdjust", async () => { adjusts += 1; });

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.inventoryUpdated).toBe(0);
    expect(adjusts).toBe(0);
  }, 120_000);
});
