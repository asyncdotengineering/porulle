import { beforeAll, describe, expect, it } from "vitest";
import { type Actor, type ChannelPushCatalogItem, type PluginTxFn } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { organization } from "@porulle/core/auth-schema";
import { eq } from "@porulle/core/drizzle";
import { commerceJobs } from "@porulle/core/schema";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap } from "../src/schema.js";

const actor: Actor = {
  type: "user",
  userId: "push-catalog-preview-admin",
  email: "push-catalog-preview-admin@test.local",
  name: "Push Catalog Preview Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};
const OTHER_ORG_ID = "push_catalog_preview_other_org";
const otherActor: Actor = { ...actor, userId: "push-catalog-preview-other-admin", email: "push-catalog-preview-other@test.local", organizationId: OTHER_ORG_ID };

describe("push catalog preview", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;
  const pushed: ChannelPushCatalogItem[][] = [];

  beforeAll(async () => {
    const connector = mockChannelConnector({
      catalog: [],
      onPushCatalog: (items) => pushed.push(items),
    });
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    await built.db.insert(organization).values({
      id: OTHER_ORG_ID,
      name: "Push Catalog Preview Other",
      slug: "push-catalog-preview-other",
      createdAt: new Date(),
    });
    service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [connector] },
      built.kernel.database.transaction as PluginTxFn,
    );
  }, 30_000);

  it("previews the same writable field set that the real push applies", async () => {
    const storeResponse = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({
        provider: "mock",
        credentials: { accessToken: "preview-parity" },
        storeDomain: "preview-parity.mock.channel.test",
      }),
    });
    expect(storeResponse.status).toBe(201);
    const store = (await storeResponse.json()).data as { id: string };
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    await service.updateCatalogFieldMapping(TEST_ORG_ID, store.id, [
      {
        fieldPath: "attributes.*.title",
        provider: "mock",
        target: "native",
        remoteKey: "title",
      },
      {
        fieldPath: "attributes.*.description",
        provider: "mock",
        target: "native",
        remoteKey: "description",
      },
    ]);

    const created = await built.kernel.services.catalog.create({
      type: "product",
      slug: "preview-parity-product",
      status: "active",
      metadata: {},
      attributes: { locale: "en", title: "Original title", description: "Store-owned description" },
    }, actor);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    const entityId = created.value.id;
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId: store.id,
      kind: "entity",
      externalId: "preview-parity-remote",
      entityId,
      syncHash: "preview-parity",
    });
    expect((await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", store.id, "platform", actor)).ok).toBe(true);
    expect((await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.description", store.id, "store", actor)).ok).toBe(true);

    expect((await service.pushCatalogToStore(TEST_ORG_ID, store.id, [entityId])).ok).toBe(true);
    pushed.length = 0;
    const updated = await built.kernel.services.catalog.setAttributes(entityId, "en", {
      title: "Updated platform title",
      description: "Store-owned description",
    }, actor);
    expect(updated.ok).toBe(true);
    const jobsBeforePreview = await built.db.select({ id: commerceJobs.id }).from(commerceJobs).where(eq(commerceJobs.taskSlug, "channel/push-catalog"));

    const previewResponse = await built.app.request(`http://localhost/api/channels/stores/${store.id}/push-catalog/preview`, {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({}),
    });
    expect(previewResponse.status).toBe(201);
    const preview = (await previewResponse.json()).data as {
      items: Array<{
        externalId: string;
        diffs: Array<{
          fieldPath: string;
          before: unknown;
          after: unknown;
          owner: string;
          willWrite: boolean;
          target: string | null;
          remoteKey: string | null;
          reason?: string;
        }>;
      }>;
    };
    const item = preview.items.find((entry) => entry.externalId === "preview-parity-remote");
    expect(item).toBeDefined();
    expect(item?.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldPath: "attributes.en.title",
        before: "Original title",
        beforeStatus: "value",
        after: "Updated platform title",
        owner: "platform",
        willWrite: true,
        target: "native",
        remoteKey: "title",
      }),
      expect.objectContaining({
        fieldPath: "attributes.en.description",
        before: null,
        beforeStatus: "missing",
        after: "Store-owned description",
        owner: "store",
        willWrite: false,
        target: "native",
        remoteKey: "description",
        reason: "store_owned",
      }),
    ]));
    expect(pushed).toHaveLength(0);
    const jobsAfterPreview = await built.db.select({ id: commerceJobs.id }).from(commerceJobs).where(eq(commerceJobs.taskSlug, "channel/push-catalog"));
    expect(jobsAfterPreview).toHaveLength(jobsBeforePreview.length);

    expect((await service.pushCatalogToStore(TEST_ORG_ID, store.id, [entityId])).ok).toBe(true);
    const appliedFieldPaths = pushed.flatMap((batch) => batch.flatMap((pushItem) => pushItem.fields.map((field) => field.fieldPath)));
    const previewedWritablePaths = item?.diffs.filter((diff) => diff.willWrite).map((diff) => diff.fieldPath) ?? [];
    expect(appliedFieldPaths).toEqual(previewedWritablePaths);
  }, 30_000);

  it("marks a missing previousFields response as unavailable instead of null", async () => {
    const storeResponse = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({
        provider: "mock",
        credentials: { accessToken: "preview-unavailable" },
        storeDomain: "preview-unavailable.mock.channel.test",
      }),
    });
    expect(storeResponse.status).toBe(201);
    const store = (await storeResponse.json()).data as { id: string };
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, store.id, true);
    await service.updateCatalogFieldMapping(TEST_ORG_ID, store.id, [{
      fieldPath: "attributes.*.title",
      provider: "mock",
      target: "native",
      remoteKey: "title",
    }]);
    const created = await built.kernel.services.catalog.create({
      type: "product",
      slug: "preview-unavailable-product",
      status: "active",
      metadata: {},
      attributes: { locale: "en", title: "Unseeded title", description: "Description" },
    }, actor);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId: store.id,
      kind: "entity",
      externalId: "preview-unavailable-remote",
      entityId: created.value.id,
      syncHash: "preview-unavailable",
    });
    expect((await built.kernel.services.catalog.setFieldOwner(created.value.id, "attributes.en.title", store.id, "platform", actor)).ok).toBe(true);

    const previewResponse = await built.app.request(`http://localhost/api/channels/stores/${store.id}/push-catalog/preview`, {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({ entityIds: [created.value.id] }),
    });
    expect(previewResponse.status).toBe(201);
    const preview = (await previewResponse.json()).data as {
      items: Array<{ diffs: Array<{ fieldPath: string; before: unknown; beforeStatus: string }> }>;
    };
    expect(preview.items[0]?.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldPath: "attributes.en.title",
        before: { status: "unavailable" },
        beforeStatus: "unavailable",
      }),
    ]));
  }, 30_000);

  it("rejects an organization from previewing another organization's store", async () => {
    const storeResponse = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({
        provider: "mock",
        credentials: { accessToken: "preview-cross-tenant" },
        storeDomain: "preview-cross-tenant.mock.channel.test",
      }),
    });
    expect(storeResponse.status).toBe(201);
    const store = (await storeResponse.json()).data as { id: string };

    const previewResponse = await built.app.request(`http://localhost/api/channels/stores/${store.id}/push-catalog/preview`, {
      method: "POST",
      headers: jsonHeaders(otherActor),
      body: JSON.stringify({}),
    });
    expect(previewResponse.status).toBe(404);
  }, 30_000);
});
