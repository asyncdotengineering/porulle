/**
 * A variant-only change must leave a trace a consumer can version from.
 *
 * The consumer versions a product for its search index from the newest of the entity's
 * `updated_at`, approvals, inventory levels and prices. A change to ONLY a variant (its option
 * values, today; see the converge path in `upsertVariants`) moved none of those — `variants` had no
 * `updated_at` and the entity row is not touched — so the change computed an unchanged version and
 * the index dropped it as stale.
 *
 * The control matters as much: a replay that changes nothing must NOT move the timestamp, or every
 * reconcile looks newer and re-projects the catalogue (the 2026-09-24 storm's shape).
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { sql } from "@porulle/core/drizzle";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);

function dress(size: "s" | "m"): ChannelCatalogItem {
  return {
    externalId: "dress-1",
    slug: "dress-1",
    title: "Dress",
    attributes: [{ locale: "en", title: "Dress" }],
    status: "active",
    options: [{
      name: "size",
      displayName: "Size",
      sortOrder: 0,
      values: [{ value: "s", displayValue: "S", sortOrder: 0 }, { value: "m", displayValue: "M", sortOrder: 1 }],
    }],
    variants: [{ externalId: "dress-1-v1", sku: "DRESS-1", optionValues: { size }, prices: [{ amount: 1000, currency: "LKR" }] }],
  };
}

async function importedDress() {
  const remote = { catalog: [dress("s")] };
  const connector = mockChannelConnector(remote);
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "variant-updated-at.test" }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const imported = await service.reconcile(TEST_ORG_ID, storeId, actor());
  expect(imported.ok && imported.value.imported).toBe(1);
  // Read through SQL, not the table object: at the commit before this change the column does not
  // exist, and the row must fail on that, at runtime, rather than not compile.
  const variantUpdatedAt = async (): Promise<string> => {
    const result: unknown = await built.db.execute(sql`select updated_at::text as at from variants where sku = 'DRESS-1'`);
    const rows: unknown[] = Array.isArray(result)
      ? result
      : typeof result === "object" && result !== null && "rows" in result && Array.isArray(result.rows) ? result.rows : [];
    const first: unknown = rows[0];
    const at = typeof first === "object" && first !== null && "at" in first ? first.at : undefined;
    if (typeof at !== "string") throw new Error("no DRESS-1 variant row");
    return at;
  };
  return { remote, service, storeId, variantUpdatedAt };
}

describe("variants.updated_at", () => {
  it("moves when a converge changes only a variant's option values", async () => {
    const { remote, service, storeId, variantUpdatedAt } = await importedDress();
    const before = await variantUpdatedAt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    remote.catalog[0] = dress("m");

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(1);
    expect(await variantUpdatedAt()).not.toBe(before);
  }, 120_000);

  it("control: does not move when a reconcile changes nothing", async () => {
    const { service, storeId, variantUpdatedAt } = await importedDress();
    const before = await variantUpdatedAt();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await service.reconcile(TEST_ORG_ID, storeId, actor());

    expect(result.ok && result.value.converged).toBe(0);
    expect(await variantUpdatedAt()).toBe(before);
  }, 120_000);
});
