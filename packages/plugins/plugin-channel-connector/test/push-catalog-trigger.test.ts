import { beforeAll, describe, expect, it } from "vitest";
import { createSystemActor, type Actor, type ChannelCatalogItem, type PluginTxFn } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { commerceJobs } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import {
  catalogPushConcurrencyKey,
  channelConnectorPlugin,
  ChannelConnectorService,
  mockChannelConnector,
} from "../src/index.js";
import { CHANNEL_CONVERGENCE_CTX } from "../src/catalog-push-trigger.js";
import { channelEntityMap } from "../src/schema.js";

const actor: Actor = {
  type: "user",
  userId: "push-trigger-admin",
  email: "push-trigger-admin@test.local",
  name: "Push Trigger Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

describe("catalog push trigger", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({
      connectors: [mockChannelConnector({ catalog: [] })],
    }));
    service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [mockChannelConnector({ catalog: [] })] },
      built.kernel.database.transaction as PluginTxFn,
    );
  }, 30_000);

  function jobStoreId(input: unknown): string | undefined {
    return typeof input === "object" && input !== null && "storeId" in input
      ? String((input as { storeId: string }).storeId)
      : undefined;
  }

  async function pendingPushJobs(storeId?: string) {
    const rows = await built.db.select({ id: commerceJobs.id, input: commerceJobs.input }).from(commerceJobs).where(and(
      eq(commerceJobs.taskSlug, "channel/push-catalog"),
      eq(commerceJobs.status, "pending"),
    ));
    return storeId ? rows.filter((job) => jobStoreId(job.input) === storeId) : rows;
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
    return (await response.json()).data as { id: string };
  }

  async function createEntity(slug: string, title = "Original title") {
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

  async function mapEntity(entityId: string, storeId: string) {
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId,
      kind: "entity",
      externalId: entityId,
      entityId,
      syncHash: `trigger-${entityId}`,
    });
  }

  async function setOwner(entityId: string, storeId: string, fieldPath: string, owner: "platform" | "store") {
    const result = await built.kernel.services.catalog.setFieldOwner(entityId, fieldPath, storeId, owner, actor);
    expect(result.ok).toBe(true);
  }

  async function importScenario(item: ChannelCatalogItem) {
    const connector = mockChannelConnector({ catalog: [item] });
    const scenario = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const scenarioService = new ChannelConnectorService(
      scenario.db,
      scenario.kernel.services,
      { connectors: [connector] },
      scenario.kernel.database.transaction as PluginTxFn,
    );
    const response = await scenario.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: `${item.externalId}.test` }),
    });
    expect(response.status).toBe(201);
    const storeId = (await response.json()).data.id as string;
    const imported = await scenarioService.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(imported).toMatchObject({ ok: true, value: { imported: 1 } });
    const [entity] = await scenario.db.select().from(channelEntityMap).where(eq(channelEntityMap.externalId, item.externalId));
    expect(entity).toBeDefined();
    return { scenario, scenarioService, storeId, entityId: entity!.entityId };
  }

  it("enqueues exactly one push when a platform-owned title is edited", async () => {
    const store = await connect("push-trigger-platform");
    const entityId = await createEntity("push-trigger-platform-item");
    await mapEntity(entityId, store.id);
    await setOwner(entityId, store.id, "attributes.en.title", "platform");

    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Platform edit",
      description: "Store description",
    }, actor);

    const jobs = await pendingPushJobs(store.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.input).toMatchObject({
      organizationId: TEST_ORG_ID,
      storeId: store.id,
      entityIds: [entityId],
    });
    expect(catalogPushConcurrencyKey(jobs[0]!.input as Record<string, unknown>)).toBe(`push:${entityId}:${store.id}`);
  }, 30_000);

  it("does not enqueue when a store-owned field is edited", async () => {
    const store = await connect("push-trigger-store-owned");
    const entityId = await createEntity("push-trigger-store-owned-item");
    await mapEntity(entityId, store.id);
    await setOwner(entityId, store.id, "attributes.en.title", "store");

    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Merchant edit",
      description: "Store description",
    }, actor);

    expect(await pendingPushJobs(store.id)).toHaveLength(0);
  }, 30_000);

  it("does not enqueue when catalog writes carry the channel-convergence origin", async () => {
    const store = await connect("push-trigger-convergence-origin");
    const entityId = await createEntity("push-trigger-convergence-origin-item");
    await mapEntity(entityId, store.id);
    await setOwner(entityId, store.id, "attributes.en.title", "platform");

    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Inbound convergence write",
      description: "Store description",
    }, actor, CHANNEL_CONVERGENCE_CTX);

    expect(await pendingPushJobs(store.id)).toHaveLength(0);
  }, 30_000);

  it("does not enqueue during channel reconciliation convergence", async () => {
    const item: ChannelCatalogItem = {
      externalId: "push-trigger-converge",
      slug: "push-trigger-converge",
      title: "Converge Product",
      attributes: [{ locale: "en", title: "Converge Product", description: "Original description" }],
      variants: [],
    };
    const { scenario, scenarioService, storeId, entityId } = await importScenario(item);
    await scenario.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "platform", testAdminActor);
    await scenario.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.description", storeId, "store", testAdminActor);

    item.attributes = [{ locale: "en", title: "Remote title change", description: "Remote description change" }];
    const reconciled = await scenarioService.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(reconciled.ok).toBe(true);

    const jobs = await scenario.db.select({ id: commerceJobs.id }).from(commerceJobs).where(and(
      eq(commerceJobs.taskSlug, "channel/push-catalog"),
      eq(commerceJobs.status, "pending"),
    ));
    expect(jobs).toHaveLength(0);
  }, 30_000);

  it("collapses three platform-owned edits into one pending push job", async () => {
    const store = await connect("push-trigger-debounce");
    const entityId = await createEntity("push-trigger-debounce-item");
    await mapEntity(entityId, store.id);
    await setOwner(entityId, store.id, "attributes.en.title", "platform");
    await setOwner(entityId, store.id, "attributes.en.subtitle", "platform");
    await setOwner(entityId, store.id, "attributes.en.seoTitle", "platform");

    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "First edit",
      description: "Store description",
    }, actor);
    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Second edit",
      subtitle: "Second subtitle",
      description: "Store description",
    }, actor);
    await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Third edit",
      subtitle: "Third subtitle",
      seoTitle: "Third seo",
      description: "Store description",
    }, actor);

    expect(await pendingPushJobs(store.id)).toHaveLength(1);
  }, 30_000);

  it("enqueues a push from the manual operator endpoint", async () => {
    const store = await connect("push-trigger-manual");
    const entityId = await createEntity("push-trigger-manual-item");
    await mapEntity(entityId, store.id);

    const response = await built.app.request(`http://localhost/api/channels/stores/${store.id}/push-catalog`, {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ entityIds: [entityId] }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { enqueued: true, storeId: store.id } });

    const jobs = await pendingPushJobs(store.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.input).toMatchObject({
      organizationId: TEST_ORG_ID,
      storeId: store.id,
      entityIds: [entityId],
    });
  }, 30_000);
});
