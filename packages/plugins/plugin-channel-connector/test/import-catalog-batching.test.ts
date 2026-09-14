/**
 * One `POST /api/loom/channels/import` must finish a catalog. Today it imports roughly thirty
 * products and dies.
 *
 * Measured on the deployed Worker on 2026-09-14, one sweep from a clean commerce reset, Workflow
 * instance 053e6a64-6f67-4650-a843-2c359c6dd947: 4 -> 35 entities over 7 minutes, linear at two
 * products per twenty seconds from the first sample to the last, then a hard stop with
 *
 *   Failed query: insert into "channel_entity_map" (...) values (...)
 *   caused by: NeonDbError: Error connecting to database:
 *     Error: Too many subrequests by single Worker invocation.
 *
 * The job path runs the Neon HTTP driver, so EVERY query is its own HTTPS subrequest — about 320
 * per product across its entity, attributes, prices, variants, option values, ownership rows,
 * conflict checks and media. The paid per-invocation cap is 10,000, so 31 x 320 exhausts it and the
 * cap lands on whichever query happens to be next. The importing 100-product gflock corpus needed
 * FOUR operator sweeps.
 *
 * Raising `limits.subrequests` is not the fix: the same run is 7 minutes for 31 products, so a
 * 1,000-product merchant catalog is 3.6 hours inside a single invocation and one failure discards
 * the remainder.
 *
 * Nor is naive re-running, which already works: an already-imported item is skipped only AFTER its
 * map lookup and entity select. Re-walking 4,970 imported items costs ~9,940 subrequests before a
 * single new product is written, so resumption by rediscovery is O(n^2) and stops making progress
 * on a large catalog. That is what row 3 below states directly, and it is the row that tells the
 * real fix apart from a re-run.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type PluginDb } from "@porulle/core";
import { eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, connectedStores } from "../src/schema.js";

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

/**
 * The service's database, wrapped so every `select()` it issues is counted. A query IS a subrequest
 * on the deployed job path, so this counter is the closest a local suite can get to the resource
 * the deployed Worker actually ran out of.
 */
function countingDb(db: PluginDb) {
  const counter = { selects: 0 };
  const wrapped = new Proxy(db as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "select" && typeof value === "function") {
        return (...args: unknown[]) => {
          counter.selects += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as PluginDb;
  return { db: wrapped, counter };
}

async function scenario(catalog: ChannelCatalogItem[], domain: string) {
  const connector = mockChannelConnector({ catalog });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const { db: counted, counter } = countingDb(built.db);
  const service = new ChannelConnectorService(counted, built.kernel.services, { connectors: [connector] });
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: domain }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  return { built, service, storeId, counter };
}

const mapRows = (built: Awaited<ReturnType<typeof scenario>>["built"], storeId: string) =>
  built.db.select().from(channelEntityMap).where(eq(channelEntityMap.storeId, storeId));

const storeRow = async (built: Awaited<ReturnType<typeof scenario>>["built"], storeId: string) =>
  (await built.db.select().from(connectedStores).where(eq(connectedStores.id, storeId)))[0]!;

describe("one import sweep finishes a catalog", () => {
  it("bounds one invocation's work and reports that the catalog is not exhausted", async () => {
    const { built, service, storeId } = await scenario(catalogOf(4, "bounded"), "bounded.batching.test");

    const first = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 2 });
    expect(first.ok, `a bounded import must succeed, not error: ${first.ok ? "" : JSON.stringify(first.error)}`).toBe(true);
    if (!first.ok) return;

    expect(
      first.value.imported,
      `a bounded invocation must converge only its bound — an unbounded one exhausts the deployed Worker's subrequest cap after ~31 products`,
    ).toBe(2);
    expect(
      first.value.exhausted,
      "an invocation that stopped on its bound must report that the catalog is NOT exhausted, or nothing knows to continue it",
    ).toBe(false);
    expect(
      (await storeRow(built, storeId)).catalogCursor,
      "a bounded invocation must persist where it stopped; today catalogCursor is set to null on success and never written on failure",
    ).not.toBeNull();
    // Filtered to `entity`, and the filter is the whole point. Written unfiltered this row asserted
    // FOUR rows' worth of work had produced TWO, which the first rejected attempt satisfied exactly
    // because it skipped the variant identity rows — the gate encoded the defect it was meant to
    // catch. Row 4 below is what actually counts both kinds.
    const boundRows = (await mapRows(built, storeId)).filter((row) => row.kind === "entity");
    expect(boundRows, "only the bound may be imported").toHaveLength(2);
  }, 180_000);

  it("finishes the whole catalog across repeated bounded invocations, each product exactly once", async () => {
    const { built, service, storeId } = await scenario(catalogOf(6, "finishes"), "finishes.batching.test");

    // Asserted before the loop so this row fails on its own reason rather than on the clock: an
    // unbounded import converges the whole catalog in one call, and a re-walk is far from free —
    // `resolveFieldOwners` and `seedImportedFieldOwnership` both run BEFORE the unchanged-item
    // skip, so twenty invocations over a nine-item catalog is minutes, not seconds.
    const opening = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 2 });
    expect(opening.ok).toBe(true);
    if (!opening.ok) return;
    expect(
      opening.value.exhausted,
      "the first of three bounded invocations must report the catalog NOT exhausted, so the job knows to enqueue its own continuation",
    ).toBe(false);

    let invocations = 1;
    let exhausted = opening.value.exhausted;
    while (!exhausted && invocations < 20) {
      const result = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 2 });
      expect(result.ok, `invocation ${invocations} must succeed: ${result.ok ? "" : JSON.stringify(result.error)}`).toBe(true);
      if (!result.ok) return;
      exhausted = result.value.exhausted;
      invocations += 1;
    }

    expect(exhausted, "the continuation must terminate by exhausting the catalog, not by running out of attempts").toBe(true);
    expect(invocations, "6 items at 2 per invocation is three invocations").toBe(3);

    const rows = await mapRows(built, storeId);
    const entityRows = rows.filter((row) => row.kind === "entity");
    expect(entityRows, "every product must be mapped exactly once across the whole continuation").toHaveLength(6);
    expect(new Set(entityRows.map((row) => row.externalId)).size, "no external id may be imported twice").toBe(6);

    const slugs = await built.db.select({ slug: sellableEntities.slug }).from(sellableEntities);
    const imported = slugs.filter((row) => row.slug.startsWith("finishes-"));
    expect(imported, "no duplicate entity may be created for the same product").toHaveLength(6);
    expect(
      (await storeRow(built, storeId)).catalogCursor,
      "an exhausted catalog must clear its resume position, so the next sweep starts from the top",
    ).toBeNull();
  }, 180_000);

  it("writes every variant's identity row in the batch that created the variant", async () => {
    // `b8e2c90` / plugin 0.28.0 made the importer's identity atomic: an interrupted import must
    // never leave a variant that `channel_entity_map` cannot name, because `entity_id` and the
    // store/kind/external unique index are what recovery is built on. Batching must not re-open
    // that hole by deferring the map rows — carrying them in a JSON blob in `catalogCursor` means a
    // batch that is superseded, or a cursor write that fails, loses them permanently, and the
    // variants become exactly the orphans that made an interrupted import unrecoverable.
    //
    // The existing entity-map-atomicity suite cannot see this: it imports UNBOUNDED, and the
    // deferral only happens on the bounded path — which is the only path the deployed Worker runs.
    const { built, service, storeId } = await scenario(catalogOf(6, "identity"), "identity.batching.test");

    const first = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.exhausted, "this row is about a batch that is NOT the last").toBe(false);

    const rows = await mapRows(built, storeId);
    const entityRows = rows.filter((row) => row.kind === "entity");
    const variantRows = rows.filter((row) => row.kind === "variant");
    expect(entityRows, "two products imported means two entity identity rows").toHaveLength(2);
    expect(
      variantRows,
      "each imported product has exactly one variant, so a batch that imported two products must "
        + "have written two variant identity rows BEFORE it returned. Deferring them to a later "
        + "batch leaves variants that channel_entity_map cannot name — the orphan state b8e2c90 "
        + "exists to prevent, on the only path the deployed Worker runs.",
    ).toHaveLength(2);
  }, 180_000);

  // Measured during this card's sabotage pass, and worth knowing before trusting this row: it does
  // NOT on its own catch a missing cursor. Sabotaging the resume position to `null` left this row
  // GREEN — with no cursor every batch re-processes the SAME first items, so every batch costs the
  // same and "cost does not grow" holds while nothing whatsoever progresses. The row above, which
  // requires the continuation to terminate by exhausting the catalog, is what went red there
  // (`expected false to be true`). The two rows are only meaningful together.
  it("does not re-walk what it already imported — a batch's cost must not grow with the catalog behind it", async () => {
    const { service, storeId, counter } = await scenario(catalogOf(6, "nowalk"), "nowalk.batching.test");

    const first = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Same reason as the row above: fail here, on the bound, rather than after five unbounded
    // passes over a twenty-item catalog have run the clock out.
    expect(
      first.value.imported,
      "this row measures the cost of the LAST batch against the first; without a bound there is only ever one batch",
    ).toBe(2);
    const firstBatchSelects = counter.selects;

    // Advance to the LAST batch. By then four products are already imported, and a resumption that
    // rediscovers its position pays a map lookup and an entity select for every one of them before
    // it writes anything new.
    for (let batch = 0; batch < 1; batch += 1) {
      const next = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 2 });
      expect(next.ok).toBe(true);
    }
    const beforeLast = counter.selects;
    const last = await service.importCatalog(TEST_ORG_ID, storeId, actor(), { maxItems: 2 });
    expect(last.ok).toBe(true);
    const lastBatchSelects = counter.selects - beforeLast;

    expect(
      lastBatchSelects,
      `the last batch of two issued ${lastBatchSelects} selects against the first batch's ${firstBatchSelects}. `
        + "A batch that costs more because four products sit behind it is O(n^2) in the catalog: on a 5,000-product "
        + "merchant catalog the re-walk alone exhausts the invocation's subrequest budget before one new product "
        + "is written. Resumption must be carried in the cursor, not rediscovered from the database.",
    ).toBeLessThanOrEqual(firstBatchSelects + 4);
  }, 180_000);

  it("costs no more in total than one unbounded pass over the same catalog", async () => {
    // Without this, the row above is satisfiable backwards: make the FIRST batch more expensive and
    // every later batch matches it. Equal-cost batches are only the goal when the total is not
    // inflated to get there, so the two rows have to be read together.
    //
    // HONESTLY LABELLED: this is a REGRESSION GUARD, not a must-fail row. It was written against
    // the first rejected attempt on the suspicion that it had bought equal batches by inflating the
    // first one, and it PASSED there — the suspicion was wrong and is not claimed. It has never been
    // observed red, so it is evidence of nothing until it catches something.
    const bounded = await scenario(catalogOf(6, "totalb"), "totalb.batching.test");
    let exhausted = false;
    let guard = 0;
    while (!exhausted && guard < 10) {
      const next = await bounded.service.importCatalog(TEST_ORG_ID, bounded.storeId, actor(), { maxItems: 2 });
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      exhausted = next.value.exhausted;
      guard += 1;
    }
    const boundedSelects = bounded.counter.selects;

    const whole = await scenario(catalogOf(6, "totalw"), "totalw.batching.test");
    const once = await whole.service.importCatalog(TEST_ORG_ID, whole.storeId, actor());
    expect(once.ok).toBe(true);
    const wholeSelects = whole.counter.selects;

    expect(
      boundedSelects,
      `importing six products in three bounded batches issued ${boundedSelects} selects against `
        + `${wholeSelects} for the same six in one unbounded pass. Batching may pay a little to `
        + "re-fetch a page and resume, but it must not pay per product — a per-item lookup added so "
        + "that every batch costs the same is the equal-cost row satisfied backwards.",
    ).toBeLessThanOrEqual(Math.ceil(wholeSelects * 1.25));
  }, 300_000);
});
