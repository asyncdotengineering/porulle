import { beforeAll, describe, expect, it } from "vitest";
import {
  runPendingJobs,
  type Actor,
  type ChannelPushCatalogItem,
  type JobsAdapter,
  type PluginTxFn,
} from "@porulle/core";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { and, eq, inArray } from "@porulle/core/drizzle";
import { commerceJobs, sellableAttributes } from "@porulle/core/schema";
import {
  catalogPushConcurrencyKey,
  CATALOG_PUSH_BATCH_SIZES,
  channelConnectorPlugin,
  ChannelConnectorService,
  mockChannelConnector,
} from "../src/index.js";
import {
  channelCatalogPushEvents,
  channelCatalogPushes,
  channelEntityMap,
  connectedStores,
} from "../src/schema.js";
import { sellableEntityRevisions } from "@porulle/core/schema";

const actor: Actor = {
  type: "user",
  userId: "push-catalog-admin",
  email: "push-catalog-admin@test.local",
  name: "Push Catalog Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

describe("channel/push-catalog job", () => {
  const pushCapture = { batches: [] as ChannelPushCatalogItem[][] };
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({
      connectors: [mockChannelConnector({
        catalog: [],
        onPushCatalog: (batch) => pushCapture.batches.push(batch),
      })],
    }));
    service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [mockChannelConnector({ catalog: [] })] },
      built.kernel.database.transaction as PluginTxFn,
    );
  }, 30_000);

  function resetPushCapture() {
    pushCapture.batches.length = 0;
  }

  function jobStoreId(input: unknown): string | undefined {
    return typeof input === "object" && input !== null && "storeId" in input
      ? String((input as { storeId: string }).storeId)
      : undefined;
  }

  async function connect(domain: string) {
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({
        provider: "mock",
        credentials: { accessToken: domain },
        storeDomain: `${domain}.mock.channel.test`,
      }),
    });
    expect(response.status).toBe(201);
    const store = (await response.json()).data as { id: string };
    await service.updateCatalogFieldMapping(TEST_ORG_ID, store.id, [{
      fieldPath: "attributes.*.title",
      provider: "mock",
      target: "native",
      remoteKey: "title",
    }]);
    return store;
  }

  async function createPushEntity(slug: string, title = "Platform title") {
    const result = await built.kernel.services.catalog.create({
      type: "product",
      slug,
      status: "active",
      metadata: {},
      attributes: { locale: "en", title, description: "Store description" },
    }, actor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.value.id;
  }

  async function mapPushEntity(entityId: string, storeId: string, externalId = entityId) {
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId,
      kind: "entity",
      externalId,
      entityId,
      syncHash: `push-${entityId}`,
    });
  }

  async function setPushPlatformOwner(entityId: string, storeId: string) {
    const result = await built.kernel.services.catalog.setFieldOwner(
      entityId,
      "attributes.en.title",
      storeId,
      "platform",
      actor,
    );
    expect(result.ok).toBe(true);
  }

  async function enqueuePush(
    storeId: string,
    input: { entityIds?: string[]; cursor?: string } = {},
    options: { supersedes?: boolean } = {},
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
    return jobs.enqueue("channel/push-catalog", {
      organizationId: TEST_ORG_ID,
      storeId,
      ...input,
    }, {
      organizationId: TEST_ORG_ID,
      concurrencyKey: catalogPushConcurrencyKey({ storeId, ...input }),
      supersedes: options.supersedes ?? true,
    });
  }

  async function runJobs(limit = 100) {
    return runPendingJobs({
      db: built.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
      tasks: new Map((built.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
      logger: built.kernel.logger,
      services: built.kernel.services,
      limit,
    });
  }

  async function drainPushJobs(storeId: string, maxCycles = 20) {
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      const pending = await built.db.select({ id: commerceJobs.id, input: commerceJobs.input }).from(commerceJobs).where(and(
        eq(commerceJobs.taskSlug, "channel/push-catalog"),
        eq(commerceJobs.status, "pending"),
      ));
      const forStore = pending.filter((job) => jobStoreId(job.input) === storeId);
      if (forStore.length === 0) break;
      await runJobs(forStore.length);
    }
  }

  it("pushes 250 items across connector batches", async () => {
    resetPushCapture();
    const store = await connect("push-catalog-batch");
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const entityIds: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      const entityId = await createPushEntity(`push-catalog-batch-${index}`, `Title ${index}`);
      await mapPushEntity(entityId, store.id);
      await setPushPlatformOwner(entityId, store.id);
      entityIds.push(entityId);
    }

    await enqueuePush(store.id, {}, { supersedes: false });
    await drainPushJobs(store.id);

    expect(pushCapture.batches.length).toBe(3);
    expect(pushCapture.batches[0]).toHaveLength(100);
    expect(pushCapture.batches[1]).toHaveLength(100);
    expect(pushCapture.batches[2]).toHaveLength(50);
    const pushes = await built.db.select({ state: channelCatalogPushes.state }).from(channelCatalogPushes).where(and(
      eq(channelCatalogPushes.organizationId, TEST_ORG_ID),
      eq(channelCatalogPushes.storeId, store.id),
    ));
    expect(pushes).toHaveLength(250);
    expect(pushes.every((push) => push.state === "confirmed")).toBe(true);
  }, 30_000);

  it("marks only the failing item as failed while the rest reach confirmed", async () => {
    const partialCapture = { batches: [] as ChannelPushCatalogItem[][] };
    const failingExternalId = "push-catalog-partial-failed";
    const connector = mockChannelConnector({
      catalog: [],
      pushCatalogFailures: {
        [failingExternalId]: { code: "REMOTE_VALIDATION", message: "Rejected.", retriable: false },
      },
      onPushCatalog: (batch) => partialCapture.batches.push(batch),
    });
    const failingBuilt = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const failingService = new ChannelConnectorService(
      failingBuilt.db,
      failingBuilt.kernel.services,
      { connectors: [connector] },
      failingBuilt.kernel.database.transaction as PluginTxFn,
    );
    const store = await (async () => {
      const response = await failingBuilt.app.request("http://localhost/api/channels/stores", {
        method: "POST",
        headers: jsonHeaders(actor),
        body: JSON.stringify({
          provider: "mock",
          credentials: { accessToken: "partial" },
          storeDomain: "push-catalog-partial.mock.channel.test",
        }),
      });
      expect(response.status).toBe(201);
      const connected = (await response.json()).data as { id: string };
      await failingService.updateCatalogFieldMapping(TEST_ORG_ID, connected.id, [{
        fieldPath: "attributes.*.title",
        provider: "mock",
        target: "native",
        remoteKey: "title",
      }]);
      return connected;
    })();
    await failingService.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const createEntity = async (slug: string) => {
      const result = await failingBuilt.kernel.services.catalog.create({
        type: "product",
        slug,
        status: "active",
        metadata: {},
        attributes: { locale: "en", title: "Platform title", description: "Store description" },
      }, actor);
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      return result.value.id;
    };
    const successEntityId = await createEntity("push-catalog-partial-success");
    const failedEntityId = await createEntity("push-catalog-partial-failed");
    await failingBuilt.db.insert(channelEntityMap).values([
      {
        organizationId: TEST_ORG_ID,
        storeId: store.id,
        kind: "entity",
        externalId: successEntityId,
        entityId: successEntityId,
        syncHash: "success",
      },
      {
        organizationId: TEST_ORG_ID,
        storeId: store.id,
        kind: "entity",
        externalId: failingExternalId,
        entityId: failedEntityId,
        syncHash: "failed",
      },
    ]);
    await failingBuilt.kernel.services.catalog.setFieldOwner(successEntityId, "attributes.en.title", store.id, "platform", actor);
    await failingBuilt.kernel.services.catalog.setFieldOwner(failedEntityId, "attributes.en.title", store.id, "platform", actor);

    const failingJobs = (
      failingBuilt.kernel.services as unknown as {
        jobs: {
          enqueue: (
            task: string,
            payload: Record<string, unknown>,
            enqueueOptions: { organizationId: string; concurrencyKey: string; supersedes?: boolean },
          ) => Promise<string>;
        };
      }
    ).jobs;
    await failingJobs.enqueue("channel/push-catalog", {
      organizationId: TEST_ORG_ID,
      storeId: store.id,
      entityIds: [successEntityId, failedEntityId],
    }, {
      organizationId: TEST_ORG_ID,
      concurrencyKey: catalogPushConcurrencyKey({ storeId: store.id, entityIds: [successEntityId, failedEntityId] }),
      supersedes: true,
    });
    await runPendingJobs({
      db: failingBuilt.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
      tasks: new Map((failingBuilt.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
      logger: failingBuilt.kernel.logger,
      services: failingBuilt.kernel.services,
      limit: 10,
    });

    const pushes = await failingBuilt.db.select({
      entityId: channelCatalogPushes.entityId,
      state: channelCatalogPushes.state,
    }).from(channelCatalogPushes).where(eq(channelCatalogPushes.storeId, store.id));
    expect(pushes.find((push) => push.entityId === successEntityId)?.state).toBe("confirmed");
    expect(pushes.find((push) => push.entityId === failedEntityId)?.state).toBe("failed");
    const mappings = await failingBuilt.db.select({
      externalId: channelEntityMap.externalId,
      outboundHash: channelEntityMap.outboundHash,
    }).from(channelEntityMap).where(eq(channelEntityMap.storeId, store.id));
    expect(mappings.find((mapping) => mapping.externalId === successEntityId)?.outboundHash).toEqual(expect.any(String));
    expect(mappings.find((mapping) => mapping.externalId === failingExternalId)?.outboundHash).toBeNull();
  }, 30_000);

  it("reschedules when the breaker is open without calling the connector", async () => {
    resetPushCapture();
    const store = await connect("push-catalog-breaker");
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const entityId = await createPushEntity("push-catalog-breaker-item");
    await mapPushEntity(entityId, store.id);
    await setPushPlatformOwner(entityId, store.id);
    await built.db.update(connectedStores).set({
      breakerState: { open: true, openUntil: new Date(Date.now() + 60_000).toISOString() },
    }).where(eq(connectedStores.id, store.id));

    await enqueuePush(store.id, { entityIds: [entityId] });
    await runJobs();

    expect(pushCapture.batches).toHaveLength(0);
    const rescheduled = await built.db.select().from(commerceJobs).where(and(
      eq(commerceJobs.taskSlug, "channel/push-catalog"),
      eq(commerceJobs.status, "pending"),
    ));
    const forStore = rescheduled.filter((job) => jobStoreId(job.input) === store.id);
    expect(forStore.length).toBeGreaterThan(0);
    expect(forStore[0]?.waitUntil).toBeInstanceOf(Date);
  }, 30_000);

  it("no-ops when catalog writes are disabled", async () => {
    resetPushCapture();
    const store = await connect("push-catalog-disabled");
    const entityId = await createPushEntity("push-catalog-disabled-item");
    await mapPushEntity(entityId, store.id);
    await setPushPlatformOwner(entityId, store.id);

    await enqueuePush(store.id, { entityIds: [entityId] });
    await runJobs();

    expect(pushCapture.batches).toHaveLength(0);
    const pushes = await built.db.select().from(channelCatalogPushes).where(eq(channelCatalogPushes.storeId, store.id));
    expect(pushes).toHaveLength(0);
  }, 30_000);

  it("supersedes concurrent enqueue so only the latest canonical state is pushed", async () => {
    resetPushCapture();
    const store = await connect("push-catalog-supersede");
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const entityId = await createPushEntity("push-catalog-supersede-item", "Original title");
    await mapPushEntity(entityId, store.id);
    await setPushPlatformOwner(entityId, store.id);

    await enqueuePush(store.id, { entityIds: [entityId] });
    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Superseded title",
      description: "Store description",
    }, actor);

    await enqueuePush(store.id, { entityIds: [entityId] });

    const pending = await built.db.select({ id: commerceJobs.id, input: commerceJobs.input }).from(commerceJobs).where(and(
      eq(commerceJobs.taskSlug, "channel/push-catalog"),
      eq(commerceJobs.status, "pending"),
    ));
    expect(pending.filter((job) => jobStoreId(job.input) === store.id)).toHaveLength(1);

    await runJobs();
    expect(pushCapture.batches).toHaveLength(1);
    expect(pushCapture.batches[0]?.[0]?.fields.find((field) => field.fieldPath === "attributes.en.title")?.value).toBe("Superseded title");

    const [attribute] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(and(
      eq(sellableAttributes.entityId, entityId),
      eq(sellableAttributes.locale, "en"),
    ));
    expect(attribute?.title).toBe("Superseded title");
  }, 30_000);

  it("supersedes a pending retry so stale enqueue does not resurrect old values", async () => {
    resetPushCapture();
    const store = await connect("push-catalog-supersede-retry");
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const entityId = await createPushEntity("push-catalog-supersede-retry-item", "Stale title");
    await mapPushEntity(entityId, store.id);
    await setPushPlatformOwner(entityId, store.id);

    const staleJobId = await enqueuePush(store.id, { entityIds: [entityId] }, { supersedes: false });
    await built.db.update(commerceJobs).set({
      status: "pending",
      attempts: 1,
      waitUntil: new Date(Date.now() + 60_000),
      error: "transient transport failure",
      processingStartedAt: null,
    }).where(eq(commerceJobs.id, staleJobId));

    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Fresh title",
      description: "Store description",
    }, actor);
    await enqueuePush(store.id, { entityIds: [entityId] });

    const pending = await built.db.select({ id: commerceJobs.id }).from(commerceJobs).where(and(
      eq(commerceJobs.taskSlug, "channel/push-catalog"),
      eq(commerceJobs.status, "pending"),
      inArray(commerceJobs.id, [staleJobId]),
    ));
    expect(pending).toHaveLength(0);

    await built.db.update(commerceJobs).set({ waitUntil: null }).where(and(
      eq(commerceJobs.status, "pending"),
      eq(commerceJobs.taskSlug, "channel/push-catalog"),
    ));
    await runJobs();

    expect(pushCapture.batches).toHaveLength(1);
    expect(pushCapture.batches[0]?.[0]?.fields.find((field) => field.fieldPath === "attributes.en.title")?.value).toBe("Fresh title");
  }, 30_000);

  it("re-pushes a confirmed entity after it changes", async () => {
    resetPushCapture();
    const store = await connect("push-catalog-repush");
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const entityId = await createPushEntity("push-catalog-repush-item", "First title");
    await mapPushEntity(entityId, store.id);
    await setPushPlatformOwner(entityId, store.id);

    await enqueuePush(store.id, { entityIds: [entityId] });
    await drainPushJobs(store.id);
    expect(pushCapture.batches).toHaveLength(1);

    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Second title",
      description: "Store description",
    }, actor);
    await enqueuePush(store.id, { entityIds: [entityId] });
    await drainPushJobs(store.id);

    expect(pushCapture.batches).toHaveLength(2);
    expect(pushCapture.batches[1]?.[0]?.fields.find((field) => field.fieldPath === "attributes.en.title")?.value).toBe("Second title");
    const [pushRow] = await built.db.select({ state: channelCatalogPushes.state }).from(channelCatalogPushes).where(and(
      eq(channelCatalogPushes.storeId, store.id),
      eq(channelCatalogPushes.entityId, entityId),
    ));
    expect(pushRow?.state).toBe("confirmed");
    const events = await built.db.select({ fromState: channelCatalogPushEvents.fromState, toState: channelCatalogPushEvents.toState }).from(channelCatalogPushEvents).where(eq(channelCatalogPushEvents.organizationId, TEST_ORG_ID));
    expect(events.some((event) => event.fromState === "confirmed" && event.toState === "exported")).toBe(true);
    const revisions = await built.db.select({ reason: sellableEntityRevisions.reason }).from(sellableEntityRevisions).where(and(
      eq(sellableEntityRevisions.entityId, entityId),
      eq(sellableEntityRevisions.reason, "push"),
    ));
    expect(revisions.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("resolves zero-item batches to confirmed without error", async () => {
    resetPushCapture();
    const store = await connect("push-catalog-empty-batch");
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const draftResult = await built.kernel.services.catalog.create({
      type: "product",
      slug: "push-catalog-empty-batch-draft",
      status: "draft",
      metadata: {},
      attributes: { locale: "en", title: "Draft title", description: "Draft description" },
    }, actor);
    expect(draftResult.ok).toBe(true);
    if (!draftResult.ok) throw draftResult.error;
    const draftEntityId = draftResult.value.id;
    await mapPushEntity(draftEntityId, store.id);
    await setPushPlatformOwner(draftEntityId, store.id);

    await enqueuePush(store.id, { entityIds: [draftEntityId] });
    await drainPushJobs(store.id);

    expect(pushCapture.batches).toHaveLength(0);
    const [pushRow] = await built.db.select({ state: channelCatalogPushes.state }).from(channelCatalogPushes).where(and(
      eq(channelCatalogPushes.storeId, store.id),
      eq(channelCatalogPushes.entityId, draftEntityId),
    ));
    expect(pushRow?.state).toBe("confirmed");

    await built.kernel.services.catalog.update(draftEntityId, { status: "active" }, actor);
    resetPushCapture();
    await enqueuePush(store.id, { entityIds: [draftEntityId] });
    await drainPushJobs(store.id);

    expect(pushCapture.batches).toHaveLength(1);
    expect(pushCapture.batches[0]?.[0]?.fields.find((field) => field.fieldPath === "attributes.en.title")?.value).toBe("Draft title");
  }, 30_000);

  it("retries a transient per-item failure through failed to exported to confirmed", async () => {
    const retryCapture = { batches: [] as ChannelPushCatalogItem[][] };
    const entityExternalId = "push-catalog-transient-retry";
    const transientFailures: Record<string, { code: string; message: string; retriable: true }> = {
      [entityExternalId]: { code: "REMOTE_UNAVAILABLE", message: "Try again.", retriable: true },
    };
    const connector = mockChannelConnector({
      catalog: [],
      pushCatalogFailures: transientFailures,
      onPushCatalog: (batch) => retryCapture.batches.push(batch),
    });
    const retryBuilt = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const retryService = new ChannelConnectorService(
      retryBuilt.db,
      retryBuilt.kernel.services,
      { connectors: [connector] },
      retryBuilt.kernel.database.transaction as PluginTxFn,
    );
    const store = await (async () => {
      const response = await retryBuilt.app.request("http://localhost/api/channels/stores", {
        method: "POST",
        headers: jsonHeaders(actor),
        body: JSON.stringify({
          provider: "mock",
          credentials: { accessToken: "transient-retry" },
          storeDomain: "push-catalog-transient-retry.mock.channel.test",
        }),
      });
      expect(response.status).toBe(201);
      const connected = (await response.json()).data as { id: string };
      await retryService.updateCatalogFieldMapping(TEST_ORG_ID, connected.id, [{
        fieldPath: "attributes.*.title",
        provider: "mock",
        target: "native",
        remoteKey: "title",
      }]);
      return connected;
    })();
    await retryService.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const entityId = await (async () => {
      const result = await retryBuilt.kernel.services.catalog.create({
        type: "product",
        slug: "push-catalog-transient-retry-item",
        status: "active",
        metadata: {},
        attributes: { locale: "en", title: "Retry title", description: "Store description" },
      }, actor);
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      return result.value.id;
    })();
    await retryBuilt.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId: store.id,
      kind: "entity",
      externalId: entityExternalId,
      entityId,
      syncHash: "retry",
    });
    await retryBuilt.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", store.id, "platform", actor);

    const retryJobs = (
      retryBuilt.kernel.services as unknown as {
        jobs: {
          enqueue: (
            task: string,
            payload: Record<string, unknown>,
            enqueueOptions: { organizationId: string; concurrencyKey: string; supersedes?: boolean },
          ) => Promise<string>;
        };
      }
    ).jobs;
    await retryJobs.enqueue("channel/push-catalog", {
      organizationId: TEST_ORG_ID,
      storeId: store.id,
      entityIds: [entityId],
    }, {
      organizationId: TEST_ORG_ID,
      concurrencyKey: catalogPushConcurrencyKey({ storeId: store.id, entityIds: [entityId] }),
      supersedes: true,
    });
    await runPendingJobs({
      db: retryBuilt.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
      tasks: new Map((retryBuilt.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
      logger: retryBuilt.kernel.logger,
      services: retryBuilt.kernel.services,
      limit: 10,
    });

    const [failedPush] = await retryBuilt.db.select({ state: channelCatalogPushes.state }).from(channelCatalogPushes).where(and(
      eq(channelCatalogPushes.storeId, store.id),
      eq(channelCatalogPushes.entityId, entityId),
    ));
    expect(failedPush?.state).toBe("failed");
    expect(retryCapture.batches).toHaveLength(1);

    delete transientFailures[entityExternalId];
    await retryBuilt.db.update(commerceJobs).set({ waitUntil: null }).where(and(
      eq(commerceJobs.taskSlug, "channel/push-catalog"),
      eq(commerceJobs.status, "pending"),
    ));
    await runPendingJobs({
      db: retryBuilt.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
      tasks: new Map((retryBuilt.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
      logger: retryBuilt.kernel.logger,
      services: retryBuilt.kernel.services,
      limit: 10,
    });

    expect(retryCapture.batches).toHaveLength(2);
    const [confirmedPush] = await retryBuilt.db.select({ state: channelCatalogPushes.state }).from(channelCatalogPushes).where(and(
      eq(channelCatalogPushes.storeId, store.id),
      eq(channelCatalogPushes.entityId, entityId),
    ));
    expect(confirmedPush?.state).toBe("confirmed");
    const events = await retryBuilt.db.select({ fromState: channelCatalogPushEvents.fromState, toState: channelCatalogPushEvents.toState }).from(channelCatalogPushEvents);
    expect(events.some((event) => event.fromState === "failed" && event.toState === "exported")).toBe(true);
  }, 30_000);

  it("does not skip entities when a mapping is deleted between sweep pages", async () => {
    const cursorCapture = { batches: [] as ChannelPushCatalogItem[][] };
    const cursorConnector = mockChannelConnector({
      catalog: [],
      onPushCatalog: (batch) => cursorCapture.batches.push(batch),
    });
    const cursorBuilt = await createPluginTestApp(channelConnectorPlugin({ connectors: [cursorConnector] }));
    const cursorService = new ChannelConnectorService(
      cursorBuilt.db,
      cursorBuilt.kernel.services,
      { connectors: [cursorConnector] },
      cursorBuilt.kernel.database.transaction as PluginTxFn,
    );
    const previousBatchSize = CATALOG_PUSH_BATCH_SIZES.mock ?? 100;
    CATALOG_PUSH_BATCH_SIZES.mock = 2;
    try {
      const response = await cursorBuilt.app.request("http://localhost/api/channels/stores", {
        method: "POST",
        headers: jsonHeaders(actor),
        body: JSON.stringify({
          provider: "mock",
          credentials: { accessToken: "cursor" },
          storeDomain: "push-catalog-cursor.mock.channel.test",
        }),
      });
      expect(response.status).toBe(201);
      const store = (await response.json()).data as { id: string };
      await cursorService.updateCatalogFieldMapping(TEST_ORG_ID, store.id, [{
        fieldPath: "attributes.*.title",
        provider: "mock",
        target: "native",
        remoteKey: "title",
      }]);
      await cursorService.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);

      const entityIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const result = await cursorBuilt.kernel.services.catalog.create({
          type: "product",
          slug: `push-catalog-cursor-${index}`,
          status: "active",
          metadata: {},
          attributes: { locale: "en", title: `Cursor title ${index}`, description: "Store description" },
        }, actor);
        expect(result.ok).toBe(true);
        if (!result.ok) throw result.error;
        entityIds.push(result.value.id);
        await cursorBuilt.db.insert(channelEntityMap).values({
          organizationId: TEST_ORG_ID,
          storeId: store.id,
          kind: "entity",
          externalId: result.value.id,
          entityId: result.value.id,
          syncHash: `cursor-${index}`,
        });
        await cursorBuilt.kernel.services.catalog.setFieldOwner(result.value.id, "attributes.en.title", store.id, "platform", actor);
      }
      const sortedEntityIds = [...entityIds].sort();
      const jobs = (
        cursorBuilt.kernel.services as unknown as {
          jobs: JobsAdapter;
        }
      ).jobs;

      const firstPage = await cursorService.executeCatalogPushJob(
        TEST_ORG_ID,
        store.id,
        {},
        actor,
        { jobs },
      );
      expect(firstPage.ok).toBe(true);
      expect(firstPage.ok && firstPage.value.pushed).toBe(2);

      await cursorBuilt.db.delete(channelEntityMap).where(and(
        eq(channelEntityMap.storeId, store.id),
        eq(channelEntityMap.entityId, sortedEntityIds[0]!),
      ));

      let cursor = firstPage.ok ? firstPage.value.cursor : undefined;
      while (cursor) {
        const nextPage = await cursorService.executeCatalogPushJob(
          TEST_ORG_ID,
          store.id,
          { cursor },
          actor,
          { jobs },
        );
        expect(nextPage.ok).toBe(true);
        cursor = nextPage.ok && nextPage.value.complete !== true ? nextPage.value.cursor : undefined;
      }

      const pushes = await cursorBuilt.db.select({
        entityId: channelCatalogPushes.entityId,
        state: channelCatalogPushes.state,
      }).from(channelCatalogPushes).where(eq(channelCatalogPushes.storeId, store.id));
      const confirmedIds = pushes.filter((push) => push.state === "confirmed").map((push) => push.entityId);
      expect(confirmedIds).toHaveLength(5);
      expect(confirmedIds).toContain(sortedEntityIds[2]);
      expect(cursorCapture.batches.flat()).toHaveLength(5);
    } finally {
      CATALOG_PUSH_BATCH_SIZES.mock = previousBatchSize;
    }
  }, 30_000);

  it("excludes abandoned rows from later sweeps without erroring the batch", async () => {
    resetPushCapture();
    const store = await connect("push-catalog-abandoned");
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    const abandonedEntityId = await createPushEntity("push-abandoned-entity", "Abandoned title");
    const healthyEntityId = await createPushEntity("push-abandoned-healthy", "Healthy title");
    await mapPushEntity(abandonedEntityId, store.id);
    await mapPushEntity(healthyEntityId, store.id);
    await setPushPlatformOwner(abandonedEntityId, store.id);
    await setPushPlatformOwner(healthyEntityId, store.id);
    await built.db.insert(channelCatalogPushes).values({
      organizationId: TEST_ORG_ID,
      storeId: store.id,
      entityId: abandonedEntityId,
      state: "abandoned",
      attempts: 8,
      lastError: "Exhausted transient retries.",
    });

    await enqueuePush(store.id);
    await drainPushJobs(store.id);

    const pushes = await built.db.select({
      entityId: channelCatalogPushes.entityId,
      state: channelCatalogPushes.state,
      attempts: channelCatalogPushes.attempts,
    }).from(channelCatalogPushes).where(eq(channelCatalogPushes.storeId, store.id));
    const byEntity = new Map(pushes.map((push) => [push.entityId, push]));
    expect(byEntity.get(healthyEntityId)?.state).toBe("confirmed");
    expect(byEntity.get(abandonedEntityId)).toMatchObject({ state: "abandoned", attempts: 8 });
    const pushedExternalIds = pushCapture.batches.flat().map((item) => item.externalId);
    expect(pushedExternalIds).toContain(healthyEntityId);
    expect(pushedExternalIds).not.toContain(abandonedEntityId);
  }, 30_000);

  it("pages an unsorted deduplicated targeted entityIds list completely", async () => {
    resetPushCapture();
    const previousBatchSize = CATALOG_PUSH_BATCH_SIZES.mock ?? 100;
    CATALOG_PUSH_BATCH_SIZES.mock = 2;
    try {
      const store = await connect("push-catalog-unsorted");
      await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
      const entityIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const entityId = await createPushEntity(`push-unsorted-${index}`, `Unsorted title ${index}`);
        await mapPushEntity(entityId, store.id);
        await setPushPlatformOwner(entityId, store.id);
        entityIds.push(entityId);
      }
      const unsorted = [...entityIds].sort().reverse();
      unsorted.push(unsorted[0]!);

      await enqueuePush(store.id, { entityIds: unsorted });
      await drainPushJobs(store.id);

      const pushes = await built.db.select({
        entityId: channelCatalogPushes.entityId,
        state: channelCatalogPushes.state,
      }).from(channelCatalogPushes).where(and(
        eq(channelCatalogPushes.storeId, store.id),
        inArray(channelCatalogPushes.entityId, entityIds),
      ));
      expect(pushes.filter((push) => push.state === "confirmed")).toHaveLength(5);
      const pushedExternalIds = pushCapture.batches.flat().map((item) => item.externalId);
      expect([...new Set(pushedExternalIds)].sort()).toEqual([...entityIds].sort());
    } finally {
      CATALOG_PUSH_BATCH_SIZES.mock = previousBatchSize;
    }
  }, 30_000);
});
