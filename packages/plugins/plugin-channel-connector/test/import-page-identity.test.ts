/**
 * A batch step must hand its caller the identity of the page it just converged.
 *
 * `walkBatches` keeps only `last`, so the RETURN VALUE OF EACH `step.do` is the only per-batch seam
 * a host application has. A host that wants to emit one message per page — instead of one enqueue
 * per product, which is ~20 % of this import's wall time on the deployed Worker — has nowhere else
 * to read the page from. `convergeCatalogItems` already returns `entityIds` and the bounded
 * `importCatalog` overload already declares it; this file asserts the last hop, which is the one
 * that was missing and which no existing row could see.
 *
 * ## The ways a row here could LIE, written before the rows
 *
 *  1 It asserts `entityIds` is PRESENT and nothing about its contents, so a batch that converged 20
 *    products and returned `[]` passes.
 *      -> the union across batches is compared against the store's actual `sellable_entities` ids,
 *         read from the database, and the first batch's length is pinned to the bound.
 *
 *  2 It reads the WALK's aggregate output (`task.handler`'s return) rather than the step return, so
 *    it stays green against exactly the build this row exists to reject — one that drops the field
 *    at the step boundary and reassembles it afterwards.
 *      -> the recorder captures each step's RESOLVED VALUE. The handler's own output is not read.
 *
 *  3 It runs a single batch, so "unconditional" is never exercised on a batch that committed
 *    nothing — which is the case that makes `undefined` and `[]` indistinguishable at the seam.
 *      -> the fixture is bound+1 products, so the last batch commits one, and EVERY recorded batch
 *         is asserted to carry an array rather than `undefined`.
 *
 *  4 It compares against the mock catalog's order, which convergence is not required to preserve
 *    across batches, so it fails for a reason that is not the contract.
 *      -> sets are compared, not arrays. Order within a page is the service's row, not this one's.
 *
 *  5 `failures` is `undefined` whether or not the seam forwards it, because the happy path has
 *    none — so a row asserting `failures` on a clean import examines nothing.
 *      -> there is no `failures` row here. It is forwarded beside `entityIds` and is covered where
 *         a failure actually occurs (`converge-failure-isolation.test.ts`); a vacuous row here
 *         would be worse than none.
 */
import { describe, expect, it } from "vitest";
import type { ChannelCatalogItem } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import {
  channelConnectorPlugin,
  mockChannelConnector,
  CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION,
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

/** Records each step's NAME and its RESOLVED VALUE — lie 2 is why the value is kept. */
function recordingStep() {
  const steps: { name: string; value: unknown }[] = [];
  return {
    steps,
    step: {
      do: async (name: string, a: unknown, b?: unknown) => {
        const fn = (typeof a === "function" ? a : b) as (arg: { attempt: number }) => Promise<unknown>;
        const value = await fn({ attempt: 1 });
        steps.push({ name, value });
        return value;
      },
      sleep: async () => undefined,
    },
  };
}

describe("a batch step names the page it converged", () => {
  it("returns entityIds per batch, unconditionally, covering exactly the store's entities", async () => {
    const bound = CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION;
    // Lie 3: bound + 1 makes the second batch commit ONE product, which is the batch where a
    // conditional spread and an unconditional one stop agreeing.
    const total = bound + 1;
    const catalog = Array.from({ length: total }, (_u, index) =>
      product(`page-${String(index).padStart(3, "0")}`));
    const connector = mockChannelConnector({
      catalog,
      inventory: catalog.map((item) => ({ externalId: `${item.externalId}-v1`, available: 3 })),
    });
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const created = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "page-identity.test" }),
    });
    expect(created.status).toBe(201);
    const storeId = (await created.json()).data.id as string;

    const task = (built.kernel.config.jobs?.tasks ?? []).find((job) => job.slug === "channel/import-catalog")!;
    const recorder = recordingStep();
    const ctx = {
      db: built.db,
      services: built.kernel.services,
      logger: built.kernel.logger,
      step: recorder.step,
    } as unknown as Parameters<typeof task.handler>[0]["ctx"];
    await task.handler({ input: { orgId: TEST_ORG_ID, storeId }, ctx });

    const batches = recorder.steps.filter((entry) => entry.name.includes(":batch:"));
    expect(
      batches.length,
      `${total} products at a bound of ${bound} must be walked as ${Math.ceil(total / bound)} batches`,
    ).toBe(Math.ceil(total / bound));

    // Lie 3: present on EVERY batch, including the one that commits a single product.
    for (const batch of batches) {
      const ids = (batch.value as { entityIds?: unknown }).entityIds;
      expect(
        Array.isArray(ids),
        `${batch.name} returned no entityIds — a host reading this seam cannot tell "committed nothing" `
          + `from "this build does not report entities": ${JSON.stringify(batch.value)}`,
      ).toBe(true);
    }

    // Lie 1: the contents, against the database rather than against anything this file supplied.
    const persisted = await built.db
      .select({ id: sellableEntities.id })
      .from(sellableEntities)
      .where(eq(sellableEntities.organizationId, TEST_ORG_ID));
    const reported = batches.flatMap((batch) => (batch.value as { entityIds: string[] }).entityIds);
    expect(
      new Set(reported).size,
      "an id must be reported once — a page paid for twice is a duplicate the consumer cannot see",
    ).toBe(reported.length);
    // Lie 4: sets, not arrays. Order within one page is the service's contract, not this row's.
    expect(new Set(reported)).toEqual(new Set(persisted.map((row) => row.id)));

    const first = (batches[0]!.value as { entityIds: string[] }).entityIds;
    expect(
      first.length,
      "the first batch must name a full page, not a truncated one",
    ).toBe(bound);
  });
});
