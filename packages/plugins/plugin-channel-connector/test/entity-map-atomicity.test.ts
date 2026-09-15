/**
 * `channel_entity_map` is the importer's record of identity, and nothing ties it to the entity it
 * names. That is one defect with two faces, both measured on a deployed Worker on 2026-09-13 while
 * importing a 100-product catalog:
 *
 *   Face 1 — the entity row and its map row are written non-atomically, so an import interrupted
 *   between the two leaves an entity that the identity check cannot see. The next import treats the
 *   item as new, `catalog.create` collides on the slug, and the whole run dies. Measured: 31
 *   entities, 30 map rows, and every later import erroring on the 31st in two seconds.
 *
 *   Face 2 — `entity_id` has no foreign key. Deleting the orphan entity (the obvious operator
 *   repair) leaves its `kind='variant'` map rows behind, and those collide on
 *   `channel_entity_map_store_kind_external_unique` forever. Measured: 6 dangling rows, and twelve
 *   consecutive repair rounds each importing exactly one product and dying.
 *
 * Every row below fails for its own reason before the fix. None of them can be satisfied by a
 * healthy import — that is the shape that let this through: the existing suites only ever run
 * imports that complete.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type PluginDb, type PluginTxFn } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap } from "../src/schema.js";

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
 * Builds the app and a service whose transactions are observable: `calls` counts every transaction
 * the service opens, and setting `rollbackNext` makes the next one throw after its body has run,
 * which is exactly an import killed part-way through a single item.
 *
 * The observation sits on the db HANDLE — the service's first constructor argument, which a task
 * handler also supplies — rather than on a fourth `transaction` argument only `routes:` passes.
 * Injecting that fourth argument is what made this suite measure the REST path while asserting on
 * the import: with the adapter's transaction injected, removing the after-commit wrap from
 * `normalizeExecuteShape` left this file's runtime unchanged at 13 s while the two suites built the
 * task way went from 27 s to 467 s and 576 s.
 */
function observableDb(db: PluginDb, tx: { calls: number; rollbackNext: boolean }): PluginDb {
  return new Proxy(db as object, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "transaction" && typeof value === "function") {
        return <T>(fn: (inner: PluginDb) => Promise<T>): Promise<T> => {
          tx.calls += 1;
          return (value as PluginTxFn).call(target, async (inner: PluginDb) => {
            const result = await fn(inner);
            if (tx.rollbackNext) {
              tx.rollbackNext = false;
              throw new Error("injected interruption");
            }
            return result;
          }) as Promise<T>;
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as PluginDb;
}

async function scenario(catalog: ChannelCatalogItem[]) {
  const connector = mockChannelConnector({ catalog });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const tx = { calls: 0, rollbackNext: false };
  const service = new ChannelConnectorService(observableDb(built.db, tx), built.kernel.services, { connectors: [connector] });
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: `${catalog[0]!.externalId}.atomicity.test` }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  return { built, service, storeId, tx };
}

const entitiesWithSlug = async (built: Awaited<ReturnType<typeof scenario>>["built"], slug: string) =>
  built.db.select({ id: sellableEntities.id }).from(sellableEntities).where(eq(sellableEntities.slug, slug));

const mapRowsForStore = async (built: Awaited<ReturnType<typeof scenario>>["built"], storeId: string) =>
  built.db.select().from(channelEntityMap).where(eq(channelEntityMap.storeId, storeId));

describe("channel_entity_map identity is tied to the entity", () => {
  it("adopts an orphan entity instead of dying on its slug, so an interrupted import converges on re-run", async () => {
    const item = product("orphan-converges");
    const { built, service, storeId } = await scenario([item]);

    // Exactly the state an import killed between the two writes leaves behind: the entity exists,
    // carries the store as its source, and no map row names it.
    const orphan = await built.kernel.services.catalog.create(
      { type: "product", slug: item.slug, sourceStoreId: storeId, metadata: {} },
      testAdminActor,
    );
    expect(orphan.ok).toBe(true);
    const orphanId = (orphan as { value: { id: string } }).value.id;
    expect(await mapRowsForStore(built, storeId)).toHaveLength(0);

    const rerun = await service.importCatalog(TEST_ORG_ID, storeId, actor());
    expect(
      rerun.ok,
      `the re-run after an interrupted import must converge, not abort: ${rerun.ok ? "" : JSON.stringify(rerun.error)}`,
    ).toBe(true);

    const entities = await entitiesWithSlug(built, item.slug);
    expect(entities, "the re-run must adopt the orphan, not create a second entity for the same slug").toHaveLength(1);
    expect(entities[0]!.id, "the adopted entity must be the orphan itself").toBe(orphanId);

    const mapped = await built.db
      .select()
      .from(channelEntityMap)
      .where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity")));
    expect(mapped, "the re-run must leave the identity recorded").toHaveLength(1);
    expect(mapped[0]!.entityId, "the map row must name the adopted entity").toBe(orphanId);
    expect(mapped[0]!.externalId).toBe(item.externalId);
  }, 60_000);

  it("takes a deleted entity's map rows with it, so the obvious operator repair is not a trap", async () => {
    const item = product("cascade-on-delete");
    const { built, service, storeId } = await scenario([item]);

    const imported = await service.importCatalog(TEST_ORG_ID, storeId, actor());
    expect(imported).toMatchObject({ ok: true, value: { imported: 1 } });
    const [entity] = await entitiesWithSlug(built, item.slug);
    expect(entity).toBeDefined();
    const before = await mapRowsForStore(built, storeId);
    expect(before.length, "the import must have written both the entity and the variant map rows").toBeGreaterThan(1);

    await built.db.delete(sellableEntities).where(eq(sellableEntities.id, entity!.id));

    const after = await mapRowsForStore(built, storeId);
    expect(
      after,
      `deleting the entity left ${after.length} dangling map row(s) (${after
        .map((row) => `${row.kind}:${row.externalId}`)
        .join(", ")}); each one blocks re-importing that product forever through the store/kind/external_id unique index`,
    ).toHaveLength(0);
  }, 60_000);

  it("imports a new entity inside a transaction", async () => {
    const item = product("import-is-transactional");
    const { service, storeId, tx } = await scenario([item]);

    tx.calls = 0;
    const imported = await service.importCatalog(TEST_ORG_ID, storeId, actor());
    expect(imported).toMatchObject({ ok: true, value: { imported: 1 } });
    expect(
      tx.calls,
      "importing a new entity opened no transaction at all — the entity and its map row are written as two independent statements",
    ).toBeGreaterThan(0);
  }, 60_000);

  it("leaves neither the entity nor its map row when that transaction rolls back", async () => {
    const item = product("rollback-leaves-nothing");
    const { built, service, storeId, tx } = await scenario([item]);

    tx.rollbackNext = true;
    await service.importCatalog(TEST_ORG_ID, storeId, actor()).catch(() => undefined);

    const entities = await entitiesWithSlug(built, item.slug);
    const rows = await mapRowsForStore(built, storeId);
    expect(
      { entities: entities.length, mapRows: rows.length },
      "an interruption during the item's transaction must leave nothing half-made",
    ).toEqual({ entities: 0, mapRows: 0 });
  }, 60_000);

  /**
   * Green before the fix as well as after — recorded as a regression guard, not as a must-fail row.
   * It is here because the fix rewrites the new-entity path, and re-import idempotence is the
   * property most easily lost while doing so.
   */
  it("re-imports an unchanged catalog without duplicating entities or erroring", async () => {
    const item = product("unchanged-reimport");
    const { built, service, storeId } = await scenario([item]);

    expect(await service.importCatalog(TEST_ORG_ID, storeId, actor())).toMatchObject({ ok: true, value: { imported: 1 } });
    const second = await service.importCatalog(TEST_ORG_ID, storeId, actor());
    expect(second.ok, `a second import over an unchanged catalog must not error: ${second.ok ? "" : JSON.stringify(second.error)}`).toBe(true);
    expect(second).toMatchObject({ value: { imported: 0 } });
    expect(await entitiesWithSlug(built, item.slug)).toHaveLength(1);
  }, 60_000);
});
