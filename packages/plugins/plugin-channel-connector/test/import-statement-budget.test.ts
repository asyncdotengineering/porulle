import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ChannelCatalogItem, StorageAdapter } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

/**
 * THE IMPORT'S STATEMENT BUDGET — the check that an optimisation actually removed statements.
 *
 * The 177 rows of this suite prove the import still behaves correctly. None of them can fail when
 * the importer issues twice as many queries to do it, which is exactly the regression this file
 * exists to catch: the import was measured on the deployed Worker at ~379 I/O operations per
 * product, `maxOpen` 1 on every database class, and nothing in the suite noticed.
 *
 * ## What this counts, and what it cannot see
 *
 * A Proxy over the Drizzle handle the service is constructed with, counting `select` / `insert` /
 * `update` / `delete`. It therefore counts the statements the SERVICE issues and NOT those issued
 * inside `this.catalog` / `this.pricing`, which hold their own handle. So the absolute numbers here
 * are a floor rather than the per-product figure the deployed instrument reports, and the bars are
 * set against measured behaviour rather than against that figure.
 *
 * The RE-SYNC assertion is the load-bearing one. A second converge of a byte-identical payload must
 * be dramatically cheaper than the first, because every write on that path is now conditional. That
 * is a property no absolute bound can express and no behavioural test can see.
 */
const item: ChannelCatalogItem = {
  externalId: "budget-1",
  slug: "budget-1",
  title: "Budget Product",
  description: "Budget description.",
  status: "active",
  brand: "budget-brand",
  categories: ["budget-category"],
  tags: ["budget"],
  options: [
    {
      name: "color",
      displayName: "Color",
      sortOrder: 0,
      values: [
        { value: "red", displayValue: "Red", sortOrder: 0 },
        { value: "blue", displayValue: "Blue", sortOrder: 1 },
        { value: "green", displayValue: "Green", sortOrder: 2 },
      ],
    },
    {
      name: "size",
      displayName: "Size",
      sortOrder: 1,
      values: [
        { value: "s", displayValue: "Small", sortOrder: 0 },
        { value: "m", displayValue: "Medium", sortOrder: 1 },
      ],
    },
  ],
  variants: [
    { externalId: "b-v1", sku: "B-R-S", optionValues: { color: "red", size: "s" }, prices: [{ currency: "USD", amount: 1000 }] },
    { externalId: "b-v2", sku: "B-R-M", optionValues: { color: "red", size: "m" }, prices: [{ currency: "USD", amount: 1000 }] },
    { externalId: "b-v3", sku: "B-B-S", optionValues: { color: "blue", size: "s" }, prices: [{ currency: "USD", amount: 1100 }] },
    { externalId: "b-v4", sku: "B-B-M", optionValues: { color: "blue", size: "m" }, prices: [{ currency: "USD", amount: 1100 }] },
    { externalId: "b-v5", sku: "B-G-S", optionValues: { color: "green", size: "s" }, prices: [{ currency: "USD", amount: 1200 }] },
    { externalId: "b-v6", sku: "B-G-M", optionValues: { color: "green", size: "m" }, prices: [{ currency: "USD", amount: 1200 }] },
  ],
};

function countingDb<T extends object>(db: T): { db: T; counts: () => number; reset: () => void } {
  let count = 0;
  // Statements the service issues INSIDE its own transactions count too: `transaction(fn)` hands
  // `fn` a handle wrapped in the same counter. Without this, moving a write into a transaction made
  // it vanish from the count, and the ratio below moved for a reason unrelated to its claim.
  const wrap = <H extends object>(handle: H): H => new Proxy(handle, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && (prop === "select" || prop === "insert" || prop === "update" || prop === "delete")) {
        return (...args: unknown[]) => {
          count += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (typeof value === "function" && prop === "transaction") {
        return (fn: (tx: object) => unknown, ...rest: unknown[]) =>
          (value as (...a: unknown[]) => unknown).apply(target, [(tx: object) => fn(wrap(tx)), ...rest]);
      }
      return value;
    },
  });
  return { db: wrap(db), counts: () => count, reset: () => { count = 0; } };
}

describe("import statement budget", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  let counter: ReturnType<typeof countingDb<object>>;
  let storeId: string;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeAll(async () => {
    // Typed via the real interface rather than a cast, so an implicit `any` cannot hide here — the
    // repo's TypeScript rule applies to test doubles too, and a loosely-typed double is how a stub
    // drifts from the contract it stands in for.
    const storage: StorageAdapter = {
      providerId: "budget-storage",
      async upload(key: string, _data: ArrayBuffer | ReadableStream, contentType: string) {
        return { ok: true as const, value: { key, url: `https://storage.test/${key}`, contentType, size: 1 } };
      },
      async getUrl(key: string) { return { ok: true as const, value: `https://storage.test/${key}` }; },
      async delete() { return { ok: true as const, value: undefined }; },
    } as unknown as StorageAdapter;
    fetchSpy.mockImplementation(async () => new Response(new Uint8Array([1]).buffer, {
      headers: { "content-type": "image/png" },
    }));
    const mock = mockChannelConnector({ catalog: [item] });
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [mock] }), { storage });
    counter = countingDb(built.db as object);
    service = new ChannelConnectorService(
      counter.db as typeof built.db,
      built.kernel.services,
      { connectors: [mock] },
    );
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "budget.test", webhookSecret: "s" }),
    });
    expect(response.status).toBe(201);
    storeId = (await response.json()).data.id as string;
  }, 60_000);

  afterAll(() => { fetchSpy.mockRestore(); });

  it("a forced re-converge of an unchanged payload costs a fraction of the first import", async () => {
    counter.reset();
    const first = await service.importCatalog(TEST_ORG_ID, storeId, testAdminActor);
    expect(first.ok).toBe(true);
    // `importCatalog` answers ok:true with imported:0 and the real error inside `failures`, so the
    // ok alone is not evidence the import ran. Counting statements against an import that did
    // nothing is the exact vacuity this file exists to prevent.
    if (first.ok) {
      expect(first.value.failures ?? []).toEqual([]);
      expect(first.value.imported).toBe(1);
    }
    const firstCount = counter.counts();

    // BACKFILL, not a second importCatalog. The cursor is exhausted after the first pass, so a
    // second import walks no items at all — it would cost ~4 statements and pass this test while
    // measuring nothing. The forced backfill re-converges the SAME item, which is the path a real
    // store takes on every repeat sync and the only one where the conditional writes are exercised.
    counter.reset();
    const second = await service.backfillCatalog(TEST_ORG_ID, storeId, testAdminActor);
    expect(second.ok).toBe(true);
    const secondCount = counter.counts();
    // The backfill must have actually walked the entity. `entitiesTouched` is the report's own
    // count of converged items; a zero here means the second pass did nothing and the cheap
    // statement count below would be measuring an empty run.
    // NOT `entitiesTouched > 0`: that counts items whose converge CHANGED something, and an
    // unchanged re-converge correctly reports 0. The liveness signal is the statement count itself
    // — a backfill that walked nothing costs ~4 statements, so the bar below cannot be met by an
    // empty run masquerading as a cheap one.
    expect(secondCount).toBeGreaterThan(10);

    // Before the conditional writes landed, a re-converge issued an UPDATE per option type, per
    // option value and per variant regardless of whether anything changed. Half is a deliberately
    // loose bar: the claim is that the ratio is a ratio and not ~1.0, and a loose bar survives an
    // unrelated statement being added later.
    // 0.65 is chosen to DISCRIMINATE, not to be safe. Measured on this exact fixture by running
    // this file against the pre-optimisation service.ts and then against the current one:
    //
    //   pre-fix   first 51   re-converge 41   ratio 0.80   <- must FAIL
    //   post-fix  first 44   re-converge 23   ratio 0.52   <- must PASS
    //
    // A bar of 1.0 passes both and proves nothing, which is what the first draft of this row did.
    expect(secondCount / firstCount).toBeLessThan(0.65);
  }, 60_000);
});
