/**
 * `channel_catalog_conflicts.entity_id` and `channel_catalog_pushes.entity_id` have no foreign key.
 * Deleting the entity leaves dangling rows that hold unique slots against recreation:
 *
 *   - `channel_catalog_conflicts_open_unique` on (store_id, entity_id, field_path) WHERE state = 'open'
 *   - `channel_catalog_pushes_store_entity_unique` on (store_id, entity_id)
 *
 * The row below fails before the fix because both tables keep their rows after entity delete.
 */
import { describe, expect, it } from "vitest";
import { createSystemActor, runPendingJobs, type ChannelCatalogItem } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import {
  catalogPushConcurrencyKey,
  channelConnectorPlugin,
  ChannelConnectorService,
  mockChannelConnector,
} from "../src/index.js";
import { channelCatalogConflicts, channelCatalogPushes } from "../src/schema.js";

const actor = () => createSystemActor(TEST_ORG_ID);

function product(externalId: string): ChannelCatalogItem {
  return {
    externalId,
    slug: externalId,
    title: "Original title",
    status: "active",
    attributes: [{ locale: "en", title: "Original title", subtitle: "Original subtitle", description: "Original description" }],
    variants: [],
  };
}

async function scenario(catalog: ChannelCatalogItem[]) {
  const connector = mockChannelConnector({ catalog });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const service = new ChannelConnectorService(built.db, built.kernel.services, { connectors: [connector] });
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: `${catalog[0]!.externalId}.cascade.test` }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  return { built, service, storeId, connector, item: catalog[0]! };
}

async function enqueuePush(
  built: Awaited<ReturnType<typeof scenario>>["built"],
  storeId: string,
  entityIds: string[],
) {
  const jobs = (
    built.kernel.services as unknown as {
      jobs: {
        enqueue: (
          task: string,
          payload: Record<string, unknown>,
          enqueueOptions: { organizationId: string; concurrencyKey: string; supersedes?: boolean },
        ) => Promise<string>;
      };
    }
  ).jobs;
  return jobs.enqueue(
    "channel/push-catalog",
    { organizationId: TEST_ORG_ID, storeId, entityIds },
    {
      organizationId: TEST_ORG_ID,
      concurrencyKey: catalogPushConcurrencyKey({ storeId, entityIds }),
      supersedes: true,
    },
  );
}

async function runPushJobs(built: Awaited<ReturnType<typeof scenario>>["built"]) {
  await runPendingJobs({
    db: built.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
    tasks: new Map((built.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
    logger: built.kernel.logger,
    services: built.kernel.services,
    limit: 100,
  });
}

describe("entity delete cascades catalog conflicts and pushes", () => {
  it("removes open conflict and push rows when the entity is deleted, freeing both unique slots", async () => {
    const item = product(`cascade-delete-${crypto.randomUUID()}`);
    const { built, service, storeId } = await scenario([item]);

    const imported = await service.importCatalog(TEST_ORG_ID, storeId, actor());
    expect(imported).toMatchObject({ ok: true, value: { imported: 1 } });
    const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.slug, item.slug));
    expect(entity).toBeDefined();
    const entityId = entity!.id;

    const shared = await built.kernel.services.catalog.setFieldOwner(
      entityId,
      "attributes.en.title",
      storeId,
      "shared",
      testAdminActor,
    );
    expect(shared).toEqual({ ok: true, value: undefined });
    const local = await built.kernel.services.catalog.setAttributes(
      entityId,
      "en",
      { title: "Local title" },
      testAdminActor,
    );
    expect(local).toEqual({ ok: true, value: undefined });
    item.attributes = [{ locale: "en", title: "Remote title" }];
    const reconciled = await service.reconcile(TEST_ORG_ID, storeId, actor());
    expect(reconciled).toMatchObject({
      ok: true,
      value: { conflicts: [{ fieldPath: "attributes.en.title" }], openConflicts: 1 },
    });

    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    await service.updateCatalogFieldMapping(TEST_ORG_ID, storeId, [{
      fieldPath: "attributes.*.title",
      provider: "mock",
      target: "native",
      remoteKey: "title",
    }]);
    await enqueuePush(built, storeId, [entityId]);
    await runPushJobs(built);

    const conflictsBeforeDelete = await built.db
      .select()
      .from(channelCatalogConflicts)
      .where(and(eq(channelCatalogConflicts.storeId, storeId), eq(channelCatalogConflicts.entityId, entityId)));
    expect(
      conflictsBeforeDelete,
      "the scenario must open an open conflict on channel_catalog_conflicts_open_unique (store_id, entity_id, field_path)",
    ).toHaveLength(1);
    expect(conflictsBeforeDelete[0]).toMatchObject({
      fieldPath: "attributes.en.title",
      state: "open",
    });

    const pushesBeforeDelete = await built.db
      .select()
      .from(channelCatalogPushes)
      .where(and(eq(channelCatalogPushes.storeId, storeId), eq(channelCatalogPushes.entityId, entityId)));
    expect(
      pushesBeforeDelete,
      "the scenario must queue a catalog push row on channel_catalog_pushes_store_entity_unique (store_id, entity_id)",
    ).toHaveLength(1);

    await built.db.delete(sellableEntities).where(eq(sellableEntities.id, entityId));

    const conflictsAfterDelete = await built.db
      .select()
      .from(channelCatalogConflicts)
      .where(and(eq(channelCatalogConflicts.storeId, storeId), eq(channelCatalogConflicts.entityId, entityId)));
    expect(
      conflictsAfterDelete,
      `deleting the entity left ${conflictsAfterDelete.length} dangling open conflict row(s) for field_path=${conflictsBeforeDelete[0]!.fieldPath}; each one blocks reopening that conflict through channel_catalog_conflicts_open_unique (store_id, entity_id, field_path) WHERE state = 'open'`,
    ).toHaveLength(0);

    const pushesAfterDelete = await built.db
      .select()
      .from(channelCatalogPushes)
      .where(and(eq(channelCatalogPushes.storeId, storeId), eq(channelCatalogPushes.entityId, entityId)));
    expect(
      pushesAfterDelete,
      `deleting the entity left ${pushesAfterDelete.length} dangling push row(s); each one blocks queuing a new push for the same entity through channel_catalog_pushes_store_entity_unique (store_id, entity_id)`,
    ).toHaveLength(0);
  }, 60_000);
});
