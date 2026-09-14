/**
 * One `channel/sync-inventory` must finish a store's inventory. Today it iterates every level the
 * connector returns inside a single invocation and dies on the Workflow execution limit.
 *
 * Measured on the deployed Worker on 2026-09-14, one operator sweep from a clean three-target
 * reset, Workflow instance 1428d7e0-d5c9-4e6a-a5ac-c713f34f73b8 whose steps are
 * `porulle-turn:acquire:0-1`, `porulle:channel/sync-inventory-1`, `porulle-turn:release-1`:
 *
 *   Queued: 14:44:18   End: 14:54:20   Duration: 10 minutes
 *   Error:  WorkflowTimeoutError: Execution timed out after 600000ms
 *
 * It was killed at the limit having written **232 of ~1,299 levels**: 23 of 104 products carried
 * any inventory at all, against 100 of 100 on the previous run. `channel_entity_map` was complete
 * — 100 entity rows and 1,299 variant rows — so nothing was skipped for a missing mapping. The loop
 * simply does not finish.
 *
 * `importCatalog` already has the shape this needs: a bound per invocation, a resume position
 * persisted on the store, and a continuation the task enqueues while the work is not exhausted.
 * `connected_stores.inventory_cursor` already exists and today holds only a timestamp.
 *
 * Raising the execution limit is not the fix. 232 levels in 600 s is 2.6 s per level, so a
 * 1,000-product merchant — roughly 13,000 levels — is nine hours inside one invocation, and one
 * failure discards all of it.
 *
 * Nor is naive re-running. `setAbsolute` computes its delta from the stored level, so re-levelling
 * an already-levelled variant is a no-op in DATA and full price in WORK: it still reads the level,
 * still writes a movement row, still fires `inventory.afterAdjust` and its webhook delivery. A
 * resume that re-walks what it already did is O(n^2) and stops making progress on a large store.
 * That is what row 3 states directly, and it is the row that tells a real cursor apart from a
 * re-run.
 *
 * SLOW BY CONSTRUCTION. Every level write costs roughly twenty seconds here because
 * `deliverWebhooks` runs inside the plugin transaction on PGlite — the same defect that makes the
 * catalog batching suite slow, with its own card. A row that drives more levels than the bound
 * therefore takes minutes, not seconds. Do not read slow as hung.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type PluginDb } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { commerceJobs, inventoryLevels } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import {
  channelConnectorPlugin,
  ChannelConnectorService,
  mockChannelConnector,
  CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION,
} from "../src/index.js";

const actor = () => createSystemActor(TEST_ORG_ID);

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
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  return { built, storeId, service };
}

type Built = Awaited<ReturnType<typeof scenario>>["built"];
type Service = Awaited<ReturnType<typeof scenario>>["service"];

/** One bounded call, unwrapped. These rows are about the SERVICE's bound and cursor; the task that
 *  drives it to exhaustion is asserted in `batched-tasks-do-not-chain.test.ts`. */
async function oneBatch(service: Service, storeId: string) {
  const result = await service.syncInventory(TEST_ORG_ID, storeId, actor(), {
    maxItems: CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION,
  });
  expect(result.ok, `a bounded sync must succeed: ${result.ok ? "" : JSON.stringify(result.error)}`).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return { synced: result.value.synced, exhausted: result.value.exhausted === true };
}

/** Run a registered task exactly as the jobs engine does — the branch under test lives in the task
 *  definition, not only in the service, so driving the service directly would prove half of it. */
async function runTask(built: Built, slug: string, storeId: string) {
  const task = (built.kernel.config.jobs?.tasks ?? []).find((job) => job.slug === slug)!;
  const ctx = {
    db: built.db,
    services: built.kernel.services,
    logger: built.kernel.logger,
  } as unknown as Parameters<typeof task.handler>[0]["ctx"];
  return task.handler({ input: { orgId: TEST_ORG_ID, storeId }, ctx });
}

/** Import the whole catalog first: inventory can only be levelled for variants that exist. */
async function importWholeCatalog(built: Built, storeId: string) {
  for (let guard = 0; guard < 50; guard += 1) {
    const result = await runTask(built, "channel/import-catalog", storeId);
    if ((result as { output: { exhausted: boolean } }).output.exhausted) return;
  }
  throw new Error("the catalog did not exhaust within 50 bounded invocations");
}

const levelCount = async (db: PluginDb) =>
  (await db.select().from(inventoryLevels).where(eq(inventoryLevels.organizationId, TEST_ORG_ID))).length;

const jobsFor = (built: Built, slug: string, storeId: string) =>
  built.db
    .select()
    .from(commerceJobs)
    .where(and(eq(commerceJobs.organizationId, TEST_ORG_ID), eq(commerceJobs.taskSlug, slug)))
    .then((rows) =>
      rows.filter((row) => String((row.input as Record<string, unknown> | null)?.storeId) === storeId),
    );

describe("one inventory sync finishes a store's stock", () => {
  /**
   * ONE fixture, one import, every clause. Split across three tests this file imported
   * `bound + 1` products three times over and took ~40 minutes; the clauses are sequential
   * stages of one run, so splitting them bought isolation nobody was using and cost an import
   * each. Each assertion below carries its own message, so a failure still names which stage broke.
   */
  it("bounds each invocation, resumes without re-walking, and stops when the store is drained", async () => {
    const total = CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION + 1;
    const { built, storeId, service } = await scenario(catalogOf(total, "invdrain"), "invdrain.sync.test");
    await importWholeCatalog(built, storeId);

    // These stages drive `service.syncInventory` DIRECTLY, and that is a deliberate change from
    // when they drove the task. The task no longer returns after one batch — it walks the store to
    // exhaustion inside its own instance, because a continuation created from inside its
    // predecessor spends one of a request chain's 32 Worker invocations and the chain died
    // part-way through every import. What did NOT change is the bound, the cursor, and the
    // no-re-walk property, which were always the service's and are what these stages assert.
    // The task-level invariants moved to `batched-tasks-do-not-chain.test.ts`.

    // --- stage 1: one invocation is BOUNDED and says so -------------------------------------
    const firstOut = await oneBatch(service, storeId);

    expect(
      firstOut.exhausted,
      "one invocation over more levels than the bound must report inventory NOT exhausted",
    ).toBe(false);
    expect(
      firstOut.synced,
      `one invocation must level at most ${CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION} variants`,
    ).toBeLessThanOrEqual(CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION);
    expect(
      await levelCount(built.db),
      "the first invocation must leave the store part-levelled, or the resume clause below proves nothing",
    ).toBeLessThan(total);

    // --- stage 2: the next invocation RESUMES and does not re-walk ---------------------------
    const secondOut = await oneBatch(service, storeId);

    // The discriminating clause. `setAbsolute` computes its delta from the stored level, so
    // re-levelling an already-levelled variant is a no-op in DATA and full price in WORK. A count
    // of LEVELS therefore cannot tell a cursor from a re-walk and a count of WORK can — which is
    // why this asserts `synced`.
    expect(
      firstOut.synced + secondOut.synced,
      "the second invocation must level only the remainder, never re-walk the first batch",
    ).toBe(total);
    expect(secondOut.exhausted, "the remainder fits in one bound, so the store must now be drained").toBe(true);
    expect(await levelCount(built.db), "every variant must carry a level once the sync is exhausted").toBe(total);

    // --- stage 3: a RE-SYNC that changes nothing is STILL BOUNDED ---------------------------
    //
    // This stage replaces an earlier one asserting "a drained store reports exhausted", which was
    // wrong and dangerous: the only way to report exhausted on the first invocation is to walk the
    // WHOLE store, so that row passed an implementation whose bound counts WORK DONE rather than
    // LEVELS WALKED — and such an implementation is unbounded exactly when nothing has changed,
    // which is every sync after the first. That is the 600 s timeout coming back from the second
    // sync onward, and the row would have failed the correct fix. It encoded the defect.
    //
    // The honest contract: a sync that exhausted cleared its cursor, so the next one starts over
    // and must walk the store again — it cannot know nothing changed without looking. What must
    // hold is that it is still BOUNDED while doing so. With more levels than the bound and zero
    // work to do, the first invocation of the re-sync must report NOT exhausted.
    const thirdOut = await oneBatch(service, storeId);

    expect(
      thirdOut.synced,
      "nothing changed since the last sync, so a re-sync must do no work",
    ).toBe(0);
    expect(
      thirdOut.exhausted,
      `a re-sync over ${total} levels must stop at the bound of ${CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION} `
        + "and report NOT exhausted — a bound that counts work done instead of levels walked is no "
        + "bound at all on a store where nothing changed",
    ).toBe(false);
  }, 1_800_000);

  /** The other branch, and cheap: a store small enough to fit one bound must not chain at all. */
  it("does not chain a continuation for a store that fits in one invocation", async () => {
    const { built, storeId } = await scenario(catalogOf(2, "invsmall"), "invsmall.sync.test");
    await importWholeCatalog(built, storeId);
    const continuationsBefore = (await jobsFor(built, "channel/sync-inventory", storeId)).length;

    const result = await runTask(built, "channel/sync-inventory", storeId);
    expect(
      (result as { output: { exhausted: boolean } }).output.exhausted,
      "a two-variant store must exhaust in one invocation",
    ).toBe(true);
    expect(
      (await jobsFor(built, "channel/sync-inventory", storeId)).length - continuationsBefore,
      "an exhausted sync must NOT enqueue another batch — it would sync forever",
    ).toBe(0);
  }, 600_000);
});
