/**
 * A batched task must finish its store inside ONE Workflow instance, walking its batches as
 * successive durable steps — never by enqueueing its own successor.
 *
 * WHY, in arithmetic rather than in adjectives. Cloudflare caps a request chain at **32 Worker
 * invocations** (Service bindings, Runtime APIs: "A single request has a maximum of 32 Worker
 * invocations, and each call to a Service binding counts towards this limit"). A continuation
 * created from inside its predecessor spends one, and they never come back. Measured on the
 * deployed Worker on 2026-09-15, one import, two deaths, same error, same step
 * (`porulle-turn:acquire:0` — the coordinator call, the chain's FIRST step):
 *
 *   started inside the catalog-import chain   -> died after 18 batches, offset 360
 *   started from a fetch handler (operator resume) -> died after 30 batches, offset 960
 *
 * 18 + ~14 already spent ≈ 32. 30 + 2 ≈ 32. The number that varies is the depth the chain STARTS
 * at, which is why this looked like a random "batch 7 one day, batch 37 the next" for three
 * sessions. gflock-100 needs 65 batches; nothing that keeps a chain survives a catalog of any real
 * size, at ANY batch size — halving the batch doubles the chain.
 *
 * The deployed proof of that is on the card and cannot live in vitest. What CAN live here is the
 * structural property that produces it, and these rows assert exactly that: a task that needs many
 * batches enqueues **zero** successors and still finishes. Read them as the local half of the
 * must-fail row, not as a substitute for it.
 *
 * THE TRAP IN THE FIX. `ctx.step.do` is keyed by NAME: a repeated name replays the cached result
 * and silently skips the batch, so a loop that names every step the same thing finishes instantly,
 * reports success, and writes one batch. Row 3 is the only thing standing between this fix and that
 * one, and it is why the step recorder below captures names rather than counting calls.
 *
 * WHAT THIS FILE DOES NOT ASSERT. That an invocation is bounded, resumes, and does not re-walk —
 * those are properties of the SERVICE and are asserted in `sync-inventory-batching.test.ts` against
 * `service.syncInventory` directly. The split matters: the bound did not move, the wrapper did.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { commerceJobs, inventoryLevels } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import {
  channelConnectorPlugin,
  ChannelConnectorService,
  mockChannelConnector,
  CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION,
} from "../src/index.js";

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
  Array.from({ length: count }, (_u, index) => product(`${prefix}-${String(index).padStart(3, "0")}`));

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

/**
 * Stands in for the Cloudflare Workflow's `step`, recording every NAME it is asked to run. The
 * engine keys a step by its name; this records what the engine would key on, so row 3 can see a
 * collision that the real runtime would turn into a silently skipped batch.
 */
function recordingStep() {
  const names: string[] = [];
  return {
    names,
    step: {
      do: async (name: string, a: unknown, b?: unknown) => {
        names.push(name);
        const fn = (typeof a === "function" ? a : b) as (arg: { attempt: number }) => Promise<unknown>;
        return fn({ attempt: 1 });
      },
      sleep: async () => undefined,
    },
  };
}

async function runTask(built: Built, slug: string, storeId: string) {
  const task = (built.kernel.config.jobs?.tasks ?? []).find((job) => job.slug === slug)!;
  const recorder = recordingStep();
  const ctx = {
    db: built.db,
    services: built.kernel.services,
    logger: built.kernel.logger,
    step: recorder.step,
  } as unknown as Parameters<typeof task.handler>[0]["ctx"];
  const result = await task.handler({ input: { orgId: TEST_ORG_ID, storeId }, ctx });
  return { output: result.output as Record<string, unknown>, stepNames: recorder.names, task };
}

/** Import the whole catalog through the service (the host's lander does this in production). */
async function importWholeCatalog(service: ChannelConnectorService, storeId: string) {
  for (let guard = 0; guard < 80; guard += 1) {
    const page = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID), { maxItems: 20 });
    if (!page.ok) throw new Error(page.error);
    if (page.value.exhausted) return;
  }
  throw new Error("the catalog did not exhaust within 80 batches");
}

const levelCount = async (built: Built) =>
  (await built.db.select().from(inventoryLevels).where(eq(inventoryLevels.organizationId, TEST_ORG_ID))).length;

const jobsFor = (built: Built, slug: string, storeId: string) =>
  built.db
    .select()
    .from(commerceJobs)
    .where(and(eq(commerceJobs.organizationId, TEST_ORG_ID), eq(commerceJobs.taskSlug, slug)))
    .then((rows) =>
      rows.filter((row) => String((row.input as Record<string, unknown> | null)?.storeId) === storeId),
    );

describe("a batched task finishes inside one instance and chains nothing", () => {
  it("drains a multi-batch store in one invocation, in unique steps, enqueueing no successor", async () => {
    // The SMALLEST fixture that still discriminates, deliberately: one over the bound is two
    // batches, which separates "drains in one invocation" from today's "returns after one batch
    // and chains", and separates a correct batched walk (2) from a fix that simply dropped the
    // bound (1). A bigger fixture buys no extra discrimination and costs ~20 s per level, because
    // `deliverWebhooks` runs inside the plugin transaction on PGlite.
    const bound = CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION;
    const total = bound + 1;
    const { built, storeId, service } = await scenario(catalogOf(total, "nochain"), "nochain.sync.test");
    await importWholeCatalog(service, storeId);
    const before = (await jobsFor(built, "channel/sync-inventory", storeId)).length;

    const { output, stepNames } = await runTask(built, "channel/sync-inventory", storeId);

    // --- row 1: it finishes, in ONE invocation --------------------------------------------
    expect(
      output.exhausted,
      "one invocation must drain the whole store — a chain is what the subrequest depth limit kills",
    ).toBe(true);
    expect(
      await levelCount(built),
      "every variant must carry a level after that single invocation",
    ).toBe(total);

    // --- row 2: it chains NOTHING ----------------------------------------------------------
    // The structural cause of the deployed deaths. Every successor created from inside its
    // predecessor spends one of 32 Worker invocations, and gflock-100 needs 65 of them.
    expect(
      (await jobsFor(built, "channel/sync-inventory", storeId)).length - before,
      "a finishing sync must enqueue NO successor — each one spends a level of the 32-invocation chain budget",
    ).toBe(0);

    // --- row 3: it is still BATCHED, and every step name is UNIQUE -------------------------
    // Without the batch count this passes for an implementation that dropped the bound and did
    // one unbounded pass — which is the 600 s Workflow timeout coming back (instance 1428d7e0,
    // killed at 232 of 1,299 levels). Without the uniqueness clause it passes for a loop whose
    // steps all share a name, which the real engine answers from cache: instant, green, one
    // batch written.
    expect(
      output.batches,
      `${total} levels at a bound of ${bound} must be walked as ${Math.ceil(total / bound)} batches, `
        + "not one unbounded pass",
    ).toBe(Math.ceil(total / bound));
    expect(
      stepNames.length,
      "every batch must be its own durable step, so a retry resumes at the batch rather than the store",
    ).toBe(Math.ceil(total / bound));
    // KEEP THE ROW ABOVE. This one is vacuous over an empty list — `new Set([]).size === [].length`
    // — so it only means anything because the count is pinned to a non-zero number first. Delete
    // that row and this one goes green against a handler that takes no steps at all.
    expect(
      new Set(stepNames).size,
      `step names must be unique per batch — the engine keys a step by name and replays a repeat: ${JSON.stringify(stepNames)}`,
    ).toBe(stepNames.length);
  }, 1_800_000);
});
