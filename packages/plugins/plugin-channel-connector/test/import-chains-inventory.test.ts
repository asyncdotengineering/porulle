/**
 * An import sweep that finishes a catalog must leave a catalog somebody can BUY.
 *
 * `channel/import-catalog` walks its pages to exhaustion inside its own instance and then
 * returns. Nothing then writes `inventory_levels`. The only writers are `reconcile` and
 * `syncInventory`, and in the one deployment that runs this plugin the former was reachable only
 * through the hourly `channel/reconcile-sweep` CRON — which was removed on 2026-09-13. Since that
 * day every imported product has arrived with no inventory row at all, the consumer projection has
 * rolled up nothing, and every product has been published as out of stock.
 *
 * Measured on that deployment on 2026-09-14: 104 entities, 1303 variants, 273 inventory rows, and
 * only 25 of 104 entities carrying ANY inventory row — all-or-nothing per product, because the 25
 * are what the sweep wrote before it stopped running.
 *
 * The regression has a birthday. `89e21a7` ("Finish a catalog in one import sweep instead of thirty
 * products of it", #110) rewrote this chain AFTER the sweep that carried inventory was already
 * dead. That is the shape worth remembering: a chain gets rewritten, and the thing that used to run
 * beside it is in nobody's head.
 *
 * A second operator action would be the same defect in a new coat — the day a merchant signs, the
 * one operator action is "import this store" and it has to leave a buyable catalog. So inventory
 * belongs in the same continuation chain: catalog to exhaustion, then inventory, same store.
 */
import { describe, expect, it } from "vitest";
import type { ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { commerceJobs } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, mockChannelConnector, CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION } from "../src/index.js";

function product(externalId: string): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: `Product ${externalId}`,
    attributes: [{ locale: "en", title: `Product ${externalId}` }],
    variants: [
      {
        externalId: `${externalId}-v1`,
        sku: `${externalId}-v1`,
        prices: [{ amount: 1000, currency: "LKR" }],
        optionValues: { Size: "M" },
      },
    ],
  };
}

const catalogOf = (count: number, prefix: string) =>
  Array.from({ length: count }, (_unused, index) => product(`${prefix}-${String(index).padStart(3, "0")}`));

async function scenario(catalog: ChannelCatalogItem[], domain: string) {
  const connector = mockChannelConnector({
    catalog,
    inventory: catalog.map((item) => ({ externalId: `${item.externalId}-v1`, available: 3 })),
  });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: domain }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  return { built, storeId };
}

type Built = Awaited<ReturnType<typeof scenario>>["built"];

/** Run the registered task exactly as the jobs engine does — the branch under test lives in the
 *  task definition, not in the service, so driving the service directly would prove nothing. */
async function runImportTask(built: Built, storeId: string) {
  const task = (built.kernel.config.jobs?.tasks ?? []).find((job) => job.slug === "channel/import-catalog")!;
  const ctx = {
    db: built.db,
    services: built.kernel.services,
    logger: built.kernel.logger,
  } as unknown as Parameters<typeof task.handler>[0]["ctx"];
  return task.handler({ input: { orgId: TEST_ORG_ID, storeId }, ctx });
}

const jobsFor = (built: Built, slug: string) =>
  built.db.select().from(commerceJobs).where(and(
    eq(commerceJobs.organizationId, TEST_ORG_ID),
    eq(commerceJobs.taskSlug, slug),
  ));

const forStore = (rows: Awaited<ReturnType<typeof jobsFor>>, storeId: string) =>
  rows.filter((row) => String((row.input as Record<string, unknown> | null)?.storeId) === storeId);

describe("an import sweep leaves a buyable catalog", () => {
  it("enqueues inventory for the store once the catalog is exhausted", async () => {
    const { built, storeId } = await scenario(catalogOf(2, "buyable"), "buyable.chain.test");

    // Connecting a store already enqueues one `channel/import-catalog` — that is how an import
    // starts. Counting the absolute number after the handler runs would therefore assert the
    // connect-time job rather than the continuation, which is what the first version of this row
    // did and why it failed against a correct fix.
    const catalogJobsBefore = forStore(await jobsFor(built, "channel/import-catalog"), storeId).length;

    const result = await runImportTask(built, storeId);
    expect(
      (result as { output: { exhausted: boolean } }).output.exhausted,
      "this row is about the branch taken when the catalog IS finished; a bound of "
        + `${CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION} must exhaust a two-product catalog in one invocation`,
    ).toBe(true);

    // Red today: nothing enqueues this, so the catalog lands with no inventory and every product
    // projects as out of stock.
    expect(
      forStore(await jobsFor(built, "channel/sync-inventory"), storeId),
      "a finished catalog import must hand off to inventory for the same store",
    ).toHaveLength(1);

    // Exactly once, and paired with the continuation NOT being re-armed: an exhausted catalog that
    // also enqueues itself would sweep forever, and one that enqueues inventory twice would race
    // two writers of the same levels.
    expect(
      forStore(await jobsFor(built, "channel/import-catalog"), storeId).length - catalogJobsBefore,
      "an exhausted catalog must not enqueue ANOTHER catalog batch — it would sweep forever",
    ).toBe(0);
  }, 180_000);

  /**
   * SLOW BY CONSTRUCTION — and it is the row that keeps the chain catalog-first.
   *
   * The row above uses a catalog that fits ONE batch, so it cannot tell "enqueued once per sweep"
   * from "enqueued once per batch" — they are the same number there. This one gives the import more
   * products than its bound, so the walk takes several batches, and asserts the inventory hand-off
   * is still exactly one. Moving that enqueue into the batch loop leaves the row above green while
   * arming an inventory writer per batch, which is a race against itself.
   *
   * It also pins the shape of the walk: ZERO continuations of `channel/import-catalog` however many
   * batches it took. Every continuation created from inside its predecessor spends one of a request
   * chain's 32 Worker invocations, which is what killed these sweeps part-way through every import
   * — the arithmetic is in `batched-tasks-do-not-chain.test.ts` and on the `walkBatches` helper.
   *
   * Each imported product costs roughly twenty seconds here because `deliverWebhooks` times out
   * inside the import transaction on PGlite, so this row takes minutes. It gets cheap the day the
   * after-hooks card lands and those hooks run after commit.
   */
  it("hands off to inventory once per sweep, not once per batch, and chains nothing", async () => {
    const total = CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION + 1;
    const { built, storeId } = await scenario(catalogOf(total, "partial"), "partial.chain.test");
    // A DELTA, for the same reason the row above measures one: connecting a store already
    // enqueues a `channel/import-catalog`, so an absolute count asserts that connect-time job
    // rather than a continuation, and goes red against a correct implementation.
    const catalogJobsBefore = forStore(await jobsFor(built, "channel/import-catalog"), storeId).length;

    const result = await runImportTask(built, storeId);
    const output = (result as { output: { exhausted: boolean; batches: number } }).output;
    expect(
      output.exhausted,
      "one invocation must exhaust the catalog however many batches that takes — a chain is what the depth limit kills",
    ).toBe(true);
    expect(
      output.batches,
      `${total} products at a bound of ${CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION} must be walked as more than one batch, `
        + "or this row cannot tell once-per-sweep from once-per-batch",
    ).toBeGreaterThan(1);

    expect(
      forStore(await jobsFor(built, "channel/import-catalog"), storeId).length - catalogJobsBefore,
      "the import must chain NO continuation of itself — each one spends a level of the 32-invocation chain budget",
    ).toBe(0);
    expect(
      forStore(await jobsFor(built, "channel/sync-inventory"), storeId),
      "inventory is levelled once per sweep, after the catalog is whole — not once per batch",
    ).toHaveLength(1);
  }, 900_000);
});
