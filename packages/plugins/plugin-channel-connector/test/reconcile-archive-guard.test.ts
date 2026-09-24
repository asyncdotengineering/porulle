/**
 * `reconcile()` archives mapped products the fetch no longer lists — and a fetch that SUCCEEDED can
 * still be empty or truncated (a merchant API hiccup, pagination that stopped early, a scope change).
 * At 0.54.0 it archived every absent product with no bound, and raised `driftAlert` only after the
 * archive: an empty fetch wiped a store (found on the sim, 2026-09-24). The plan is now
 * `planAbsentArchives`, the one deletion policy the app's import finalize barrier imports too.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import {
  ABSENT_ARCHIVE_FLOOR,
  ABSENT_ARCHIVE_FRACTION,
  channelConnectorPlugin,
  ChannelConnectorService,
  mockChannelConnector,
  planAbsentArchives,
} from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);
const item = (externalId: string): ChannelCatalogItem => ({
  externalId,
  slug: externalId,
  title: `Product ${externalId}`,
  variants: [{ externalId: `${externalId}-v`, sku: `${externalId}-sku` }],
});
const TWELVE = Array.from({ length: 12 }, (_, index) => item(`p-${index}`));

async function storeOfTwelve() {
  const remote: { catalog: ChannelCatalogItem[] } = { catalog: [...TWELVE] };
  const connector = mockChannelConnector(remote);
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "archive-guard.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const imported = await service.reconcile(TEST_ORG_ID, storeId, actor());
  expect(imported.ok && imported.value.imported).toBe(12);
  const archived = async () => (await built.db.select({ slug: sellableEntities.slug }).from(sellableEntities).where(and(
    eq(sellableEntities.sourceStoreId, storeId),
    eq(sellableEntities.status, "archived"),
  ))).map((row) => row.slug).sort();
  const idOf = async (slug: string) => (await built.db.select({ id: sellableEntities.id }).from(sellableEntities).where(and(
    eq(sellableEntities.sourceStoreId, storeId),
    eq(sellableEntities.slug, slug),
  )))[0]?.id;
  return { remote, service, storeId, archived, idOf, built };
}

describe("planAbsentArchives", () => {
  const mapped = TWELVE.map((entry) => entry.externalId);
  it("refuses an empty fetch, refuses past the bound, archives within it", () => {
    expect(ABSENT_ARCHIVE_FLOOR).toBe(5);
    expect(ABSENT_ARCHIVE_FRACTION).toBe(0.2);
    expect(planAbsentArchives(mapped, [])).toMatchObject({ refused: expect.stringContaining("no products") });
    expect(planAbsentArchives(mapped, mapped.slice(0, 2))).toMatchObject({ refused: expect.stringContaining("10 of 12") });
    expect(planAbsentArchives(mapped, mapped.slice(1))).toEqual({ archive: ["p-0"] });
    // The bound is max(5, floor(20%)): 5 absent of 12 archives, 6 refuses; of 100, 20 archives, 21 refuses.
    expect(planAbsentArchives(mapped, mapped.slice(5))).toEqual({ archive: mapped.slice(0, 5) });
    expect(planAbsentArchives(mapped, mapped.slice(6))).toHaveProperty("refused");
    const hundred = Array.from({ length: 100 }, (_, index) => `h-${index}`);
    expect(planAbsentArchives(hundred, hundred.slice(20))).toEqual({ archive: hundred.slice(0, 20) });
    expect(planAbsentArchives(hundred, hundred.slice(21))).toHaveProperty("refused");
    // Nothing mapped, nothing fetched: nothing to do, and nothing to alarm about.
    expect(planAbsentArchives([], [])).toEqual({ archive: [] });
  });
});

describe("reconcile's archive guard", () => {
  it("an empty fetch over 12 mapped products archives 0, reports refused, and raises driftAlert", async () => {
    const { remote, service, storeId, archived } = await storeOfTwelve();
    remote.catalog = [];

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { archived: result.value.archived, driftAlert: result.value.driftAlert }).toEqual({ archived: 0, driftAlert: true });
    expect(result.ok && result.value.refused).toContain("no products");
    expect(await archived()).toEqual([]);
  }, 120_000);

  it("a truncated fetch (2 of 12) archives 0 and is refused", async () => {
    const { remote, service, storeId, archived } = await storeOfTwelve();
    remote.catalog = TWELVE.slice(0, 2);

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { archived: result.value.archived, driftAlert: result.value.driftAlert }).toEqual({ archived: 0, driftAlert: true });
    expect(result.ok && result.value.refused).toContain("10 of 12");
    expect(await archived()).toEqual([]);
  }, 120_000);

  it("control: one absent product archives 1, with no refusal", async () => {
    const { remote, service, storeId, archived } = await storeOfTwelve();
    remote.catalog = TWELVE.slice(1);

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.archived).toBe(1);
    expect(result.ok && result.value.refused).toBeUndefined();
    expect(await archived()).toEqual(["p-0"]);
  }, 120_000);

  it("control: a platform-owned entity.status is still skipped", async () => {
    const { remote, service, storeId, archived, idOf, built } = await storeOfTwelve();
    const entityId = await idOf("p-0");
    if (!entityId) throw new Error("p-0 was not imported");
    const owned = await built.kernel.services.catalog.setFieldOwner(entityId, "entity.status", storeId, "platform", testAdminActor);
    expect(owned.ok).toBe(true);
    remote.catalog = TWELVE.slice(1);

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && { archived: result.value.archived, skipped: result.value.skipped }).toEqual({
      archived: 0,
      skipped: [{ entityId, fieldPath: "entity.status" }],
    });
    expect(await archived()).toEqual([]);
  }, 120_000);
});
