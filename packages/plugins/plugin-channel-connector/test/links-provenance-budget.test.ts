/**
 * What link provenance (`channel_entity_links`) costs, counted on the whole-database statement log
 * — the catalog and media services' statements included — against 0.55.0 on the same test body.
 *
 * The allowance is fixed: a cold fast-path page may add ONE statement per page (the provenance
 * insert), nothing per item; an unchanged reconcile of a claimed catalogue may add ONE select per
 * batch (the claim probe) and must write nothing to `channel_entity_links`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { createPGliteTestAdapter, createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);
const N = 5;

function product(externalId: string): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: `Product ${externalId}`,
    status: "active",
    tags: ["linen", "summer"],
    categories: ["trousers", "wide-leg"],
    brand: "Atelier",
    variants: [{ externalId: `${externalId}-v1`, sku: `${externalId}-SKU`, prices: [{ amount: 1000, currency: "LKR" }] }],
  };
}

async function connectedStore(catalog: ChannelCatalogItem[]) {
  const connector = mockChannelConnector({ catalog });
  const pglite = await createPGliteTestAdapter();
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }), { databaseAdapter: pglite.adapter });
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "provenance-budget.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  return { service, storeId, queryLog: pglite.queryLog, cleanup: pglite.cleanup };
}

const provenanceWrites = (statements: string[]) =>
  statements.filter((statement) => /insert into "channel_entity_links"/i.test(statement)).length;

describe("link provenance statement budget", () => {
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(() => { cleanups.length = 0; });
  afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

  it("(a) a cold fast-path page of N new products costs at most ONE statement more than 0.55.0", async () => {
    const store = await connectedStore([]);
    cleanups.push(store.cleanup);

    store.queryLog.start();
    const page = await store.service.convergeCatalogPage(TEST_ORG_ID, store.storeId, Array.from({ length: N }, (_, index) => product(`page-${index}`)), actor());
    const statements = store.queryLog.stop();

    expect(page.ok).toBe(true);
    // Measured, same test body, N = 5: 0.55.0 57 statements → with provenance 58 (the one insert).
    expect(statements.length).toBeLessThanOrEqual(MEASURED_A.at0550 + 1);
    expect(provenanceWrites(statements)).toBeLessThanOrEqual(1);
  }, 120_000);

  it("(b) an unchanged reconcile of a claimed catalogue costs at most ONE select more than 0.55.0, and writes no provenance", async () => {
    const store = await connectedStore(Array.from({ length: N }, (_, index) => product(`p-${index}`)));
    cleanups.push(store.cleanup);
    const imported = await store.service.reconcile(TEST_ORG_ID, store.storeId, actor());
    expect(imported.ok && imported.value.imported).toBe(N);

    store.queryLog.start();
    const unchanged = await store.service.reconcile(TEST_ORG_ID, store.storeId, actor());
    const statements = store.queryLog.stop();

    // Measured, same test body, N = 5: 0.55.0 28 statements → with provenance 29 (the one claim select).
    expect(unchanged.ok && unchanged.value.converged).toBe(0);
    expect(statements.length).toBeLessThanOrEqual(MEASURED_B.at0550 + 1);
    expect(provenanceWrites(statements)).toBe(0);
  }, 120_000);
});

// Measured with the 0.55.0 source (b64e132) swapped in, same test body — not guessed.
const MEASURED_A = { at0550: 57 };
const MEASURED_B = { at0550: 28 };
