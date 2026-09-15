/**
 * The connector's import must run inside an after-commit boundary, on the db handle production
 * actually hands it.
 *
 * `ChannelConnectorService` opens its transactions through `this.transact`. A task handler
 * constructs the service with three arguments, so `this.transact` is `ctx.db.transaction` — the
 * plugin db HANDLE, not the adapter — and the after-commit boundary on that path exists only
 * because `normalizeExecuteShape`'s proxy wraps `transaction` in `withDeferredHooks`. Without that
 * wrap an after-hook runs inside the still-open transaction and blocks on the connection holding
 * it: `deliverWebhooks` then times out after 20 seconds, per write.
 *
 * Nothing failed when that was measured. Removing the wrap from the built core on 2026-09-15 made
 * four connector suites take 578 s instead of 27 s and log 51 `Hook "deliverWebhooks" timed out
 * after 20000ms` errors — with **exit 0 and 22 of 22 tests passing**, because `runAfterHooks`
 * collects after-hook failures into a `HookReport` and never throws. A suite that waits for a
 * symptom will not see this; it has to ask whether the boundary is there.
 *
 * Two of those four suites did not even slow down: they injected the adapter's `transaction` as a
 * fourth constructor argument, which is the shape `routes:` uses and no task handler does, so they
 * were measuring a path the deployed import never takes.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type PluginDb } from "@porulle/core";
import {
  createPluginTestApp,
  isInsideTransaction,
  jsonHeaders,
  TEST_ORG_ID,
  testAdminActor,
} from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";

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

/**
 * The service's db handle, wrapped so each transaction it opens reports whether an after-commit
 * boundary was established around its body. The wrap sits on the HANDLE — the first constructor
 * argument, which production also supplies — so the service is still built the three-argument way
 * a task handler builds it.
 */
function boundaryWatchingDb(db: PluginDb) {
  const seen: boolean[] = [];
  const wrapped = new Proxy(db as object, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "transaction" && typeof value === "function") {
        return (fn: (tx: unknown) => Promise<unknown>) =>
          (value as (f: typeof fn) => Promise<unknown>).call(target, async (tx) => {
            const inside = isInsideTransaction();
            seen.push(inside);
            // Abandon the transaction rather than let the import run without a boundary. Left to
            // run, the first after-hook inside it blocks on this transaction's own connection and
            // the test dies on its 30s budget instead of on the assertion below — a slow, unnamed
            // red that says "timed out" where it should say which transaction had no boundary.
            if (!inside) throw new Error("no after-commit boundary around this transaction");
            return fn(tx);
          });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as PluginDb;
  return { db: wrapped, seen };
}

describe("the import runs inside an after-commit boundary", () => {
  it("establishes one for every transaction the service opens on the production db handle", async () => {
    const connector = mockChannelConnector({ catalog: [product("boundary-000"), product("boundary-001")] });
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const { db: watched, seen } = boundaryWatchingDb(built.db);

    // Three arguments: exactly how every task handler in src/index.ts constructs it, and therefore
    // the only construction that exercises the deployed import's transaction path.
    const service = new ChannelConnectorService(watched, built.kernel.services, { connectors: [connector] });

    const created = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: "boundary.aftercommit.test" }),
    });
    expect(created.status).toBe(201);
    const storeId = (await created.json()).data.id as string;

    // The boundary assertions below are the verdict; the import is only how transactions get
    // opened, and it is expected to fail when the watcher above abandons one.
    const result = await service.importCatalog(TEST_ORG_ID, storeId, actor()).catch(() => null);

    // Asserted before the boundary check: `every` over an empty array is true, so a service that
    // opened no transaction at all would otherwise pass this test without running the code it is
    // about.
    expect(
      seen.length,
      "the import must open at least one transaction on the db handle, or this test is measuring nothing",
    ).toBeGreaterThan(0);

    expect(
      seen.filter((inside) => !inside).length,
      `${seen.filter((inside) => !inside).length} of ${seen.length} transactions ran with NO after-commit ` +
        `boundary. Every after-hook inside one of those runs while the transaction is still open and ` +
        `blocks on its connection — 20 seconds per hook, reported nowhere, because after-hook failures ` +
        `are collected into a HookReport rather than thrown.`,
    ).toBe(0);

    expect(result?.ok, `with every boundary in place the import must also succeed: ${
      result && !result.ok ? JSON.stringify(result.error) : ""
    }`).toBe(true);
  });
});
