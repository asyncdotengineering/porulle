/**
 * A store's inventory sync takes ONE catalogue page per step and writes it set-based.
 *
 * It levelled 20 variants per step and every step re-read the store's WHOLE inventory
 * (`fetchInventory`) and every map row: on the sim a 27k-variant store levelled 1,340 levels in 67
 * steps and then the Workflow instance died at a cumulative ceiling (attempt 3, 2026-09-25). A
 * connector with `fetchInventoryPage` now costs one page fetch per step, the page's levels go
 * through `inventory.setAbsoluteMany` in a constant number of statements, and the page is
 * announced once through `inventory.afterAdjustMany`, grouped by product.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type ChannelConnector } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { inventoryLevels, sellableEntities } from "@porulle/core/schema";
import { createPGliteTestAdapter, createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);
const PRODUCTS = 30;
const VARIANTS = 9;

function catalog(): ChannelCatalogItem[] {
  return Array.from({ length: PRODUCTS }, (_, p) => ({
    externalId: `p-${p}`,
    slug: `p-${p}`,
    title: `Product ${p}`,
    status: "active",
    variants: Array.from({ length: VARIANTS }, (_, v) => ({ externalId: `p-${p}-v${v}`, sku: `P${p}-V${v}` })),
  }));
}

async function pagedStore(pageSize: number) {
  const remote = {
    catalog: catalog(),
    inventory: catalog().flatMap((item) => item.variants.map((variant, index) => ({ externalId: variant.externalId, available: index + 1 }))),
  };
  const base = mockChannelConnector(remote);
  const calls = { full: 0, pages: 0 };
  const connector: ChannelConnector = {
    ...base,
    async fetchInventory(store, ids) { calls.full += 1; return base.fetchInventory(store, ids); },
    async fetchInventoryPage(_store, cursor) {
      calls.pages += 1;
      const start = cursor === null ? 0 : Number(cursor);
      const levels = remote.inventory.slice(start, start + pageSize);
      const next = start + pageSize;
      return { ok: true, value: { levels, nextCursor: next < remote.inventory.length ? String(next) : null } };
    },
  };
  const pglite = await createPGliteTestAdapter();
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }), { databaseAdapter: pglite.adapter });
  const announcements: Array<{ entities: Array<{ entityId: string; levels: unknown[] }> }> = [];
  let perLevel = 0;
  built.kernel.hooks.append("inventory.afterAdjustMany", async (args: { result: (typeof announcements)[number] }) => { announcements.push(args.result); });
  built.kernel.hooks.append("inventory.afterAdjust", async () => { perLevel += 1; });
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "inventory-paged.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const imported = await service.convergeCatalogPage(TEST_ORG_ID, storeId, remote.catalog, actor());
  expect(imported.ok && imported.value.failures).toEqual([]);
  const sync = async () => {
    let steps = 0;
    for (;;) {
      const step = await service.syncInventory(TEST_ORG_ID, storeId, actor());
      expect(step.ok).toBe(true);
      steps += 1;
      if (!step.ok || step.value.exhausted === true || steps > 20) return steps;
    }
  };
  const levelCount = async () => (await built.db.select({ id: inventoryLevels.id }).from(inventoryLevels)
    .innerJoin(sellableEntities, eq(sellableEntities.id, inventoryLevels.entityId))
    .where(eq(sellableEntities.sourceStoreId, storeId))).length;
  return { remote, service, storeId, built, calls, announcements, perLevel: () => perLevel, sync, levelCount, queryLog: pglite.queryLog };
}

describe("paged inventory sync", () => {
  it("levels EVERY variant, one page per step, never re-reading the whole inventory", async () => {
    const store = await pagedStore(100);

    const steps = await store.sync();

    expect(steps).toBe(Math.ceil((PRODUCTS * VARIANTS) / 100));
    expect(await store.levelCount()).toBe(PRODUCTS * VARIANTS);
    expect(store.calls).toEqual({ full: 0, pages: steps });
  }, 180_000);

  it("a page changing 9 variants of ONE product announces once, for that product; nothing per level", async () => {
    const store = await pagedStore(100);
    await store.sync();
    store.announcements.length = 0;
    const perLevelBefore = store.perLevel();
    for (const level of store.remote.inventory.filter((entry) => entry.externalId.startsWith("p-0-"))) level.available += 10;

    await store.sync();

    expect(store.announcements).toHaveLength(1);
    expect(store.announcements[0]?.entities).toHaveLength(1);
    expect(store.announcements[0]?.entities[0]?.levels).toHaveLength(9);
    expect(store.perLevel() - perLevelBefore).toBe(0);
  }, 180_000);

  it("storm guard: an unchanged sync writes no level and announces nothing", async () => {
    const store = await pagedStore(100);
    await store.sync();
    store.announcements.length = 0;
    const perLevelBefore = store.perLevel();

    store.queryLog.start();
    await store.sync();
    const statements = store.queryLog.stop();

    expect(store.announcements).toEqual([]);
    expect(store.perLevel() - perLevelBefore).toBe(0);
    expect(statements.filter((statement) => /^\s*(insert|delete)/i.test(statement) || /^\s*update\s+"inventory_levels"/i.test(statement))).toEqual([]);
  }, 180_000);

  it("budget: statements per page are the same for a page of 10 levels and a page of 100", async () => {
    const perPage = async (pageSize: number) => {
      const store = await pagedStore(pageSize);
      store.queryLog.start();
      const step = await store.service.syncInventory(TEST_ORG_ID, store.storeId, actor());
      const statements = store.queryLog.stop().length;
      expect(step.ok).toBe(true);
      return statements;
    };

    const small = await perPage(10);
    const large = await perPage(100);

    expect(large).toBe(small);
  }, 180_000);
});
