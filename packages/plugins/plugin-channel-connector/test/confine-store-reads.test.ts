import { beforeAll, describe, expect, it } from "vitest";
import { createPluginTestApp, TEST_ORG_ID } from "@porulle/core/testing";
import { channelConnectorPlugin } from "../src/index.js";
import { ChannelConnectorService } from "../src/service.js";
import { connectedStores } from "../src/schema.js";

/**
 * `listStores` filtered on `organizationId` alone, so every caller saw every store in the
 * organization. That is correct for a single-tenant deployment and wrong for a marketplace, where
 * one organization holds many sellers — and the consumer that found it has exactly that shape.
 *
 * The seam is a PREDICATE the consumer supplies, not a vendor concept in this plugin. `vendor` is a
 * marketplace model the app owns; this package is generic commerce and must stay that way. It
 * receives a set of ids and applies them in the WHERE clause.
 *
 * **Why the predicate and not a filter over the result:** a post-fetch filter still reads every
 * seller's rows out of the database and discards some, so any other caller of `listStores` stays
 * unconfined and a change to the returned shape breaks the filter silently. Confinement belongs
 * where the rows are chosen.
 *
 * The empty array is the case worth writing a test around rather than reasoning about. `[]` means
 * "this caller may read nothing", and the two plausible implementations differ in the direction
 * that matters: a missing guard turns `inArray(id, [])` into a no-op and returns EVERY store, which
 * is the failure that looks like success.
 */
describe("listStores applies the consumer's read predicate", () => {
  const confinement: { ids: readonly string[] | null; calls: number } = { ids: null, calls: 0 };
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  const storeIds: string[] = [];

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({}));
    for (let index = 0; index < 3; index += 1) {
      const id = crypto.randomUUID();
      storeIds.push(id);
      await built.db.insert(connectedStores).values({
        id,
        organizationId: TEST_ORG_ID,
        provider: "mock",
        credentials: {},
        storeDomain: `${id}.confine.test`,
        // Deliberately not all `connected`: `listStores` has no status predicate and must not
        // acquire one here. Measured on the deployed route 2026-09-19 — it returns disconnected
        // stores, and a "confinement" change that quietly filtered them would be a regression
        // wearing a security fix's clothes.
        ...(index === 2 ? { status: "disconnected" as const } : {}),
      });
    }
  }, 30_000);

  const listWith = async (ids: readonly string[] | null) => {
    confinement.ids = ids;
    confinement.calls = 0;
    const service = new ChannelConnectorService(built.db, {}, {
      confineStoreReads: async () => {
        confinement.calls += 1;
        return confinement.ids;
      },
    });
    const result = await service.listStores(TEST_ORG_ID, { orgId: TEST_ORG_ID, actor: null, raw: undefined });
    if (!result.ok) throw new Error(`listStores failed: ${JSON.stringify(result)}`);
    return result.value.map((store) => store.id);
  };

  it("returns only the ids the consumer allows", async () => {
    const listed = await listWith([storeIds[0]!]);
    expect(listed).toEqual([storeIds[0]]);
    expect(confinement.calls).toBe(1);
  });

  it("returns NOTHING for an empty allow-list, rather than everything", async () => {
    expect(await listWith([])).toEqual([]);
  });

  it("returns every store in the organization when the consumer declines to confine", async () => {
    const listed = await listWith(null);
    expect([...listed].sort()).toEqual([...storeIds].sort());
  });

  it("keeps returning disconnected stores — confinement is not a status filter", async () => {
    const listed = await listWith(null);
    expect(listed).toContain(storeIds[2]);
  });

  it("is unconfined when the consumer supplies no predicate at all", async () => {
    const service = new ChannelConnectorService(built.db, {}, {});
    const result = await service.listStores(TEST_ORG_ID, { orgId: TEST_ORG_ID, actor: null, raw: undefined });
    if (!result.ok) throw new Error("listStores failed");
    expect([...result.value.map((store) => store.id)].sort()).toEqual([...storeIds].sort());
  });
});
