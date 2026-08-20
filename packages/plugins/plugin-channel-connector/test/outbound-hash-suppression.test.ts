import { describe, expect, it, vi } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type ChannelConnector, type ChannelPushCatalogItem, type PluginTxFn } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { sellableAttributes, sellableCustomFields, sellableEntityRevisions } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { CATALOG_OUTBOUND_SUPPRESSION_WINDOW_MS, channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, connectedStores } from "../src/schema.js";

async function createOutboundScenario(slug: string, connector: ChannelConnector) {
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const service = new ChannelConnectorService(
    built.db,
    built.kernel.services,
    { connectors: [connector] },
    built.kernel.database.transaction as PluginTxFn,
  );
  const response = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: connector.providerId, credentials: {}, storeDomain: `${slug}.test` }),
  });
  expect(response.status).toBe(201);
  const storeId = (await response.json()).data.id as string;
  await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
  const created = await built.kernel.services.catalog.create({
    type: "product",
    slug,
    status: "active",
    metadata: {},
    attributes: { locale: "en", title: "Pushed title", description: "Store description" },
  }, testAdminActor);
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  const entityId = created.value.id;
  await built.db.insert(channelEntityMap).values({
    organizationId: TEST_ORG_ID,
    storeId,
    kind: "entity",
    externalId: slug,
    entityId,
    syncHash: "before-push",
  });
  await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "platform", testAdminActor);
  return { built, service, storeId, entityId };
}

describe("channel outbound hash suppression", () => {
  it("suppresses a push echo while converging a genuinely different webhook", async () => {
    const pushed: ChannelPushCatalogItem[] = [];
    const connector = { ...mockChannelConnector({ onPushCatalog: (items) => pushed.push(...items) }), providerId: "shopify" };
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [connector] },
      built.kernel.database.transaction as PluginTxFn,
    );
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "shopify", credentials: {}, storeDomain: "outbound-hash.test" }),
    });
    expect(response.status).toBe(201);
    const storeId = (await response.json()).data.id as string;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const created = await built.kernel.services.catalog.create({
      type: "product",
      slug: "outbound-hash-product",
      status: "active",
      metadata: {},
      attributes: { locale: "en", title: "Pushed title", description: "Store description" },
    }, testAdminActor);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    const entityId = created.value.id;
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId,
      kind: "entity",
      externalId: "outbound-hash-product",
      entityId,
      syncHash: "before-push",
    });
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "platform", testAdminActor);

    const pushedResult = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(pushedResult).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "outbound-hash-product", ok: true }], skipped: [], warnings: [] } });
    const pushedTitle = pushed[0]?.fields.find((field) => field.fieldPath === "attributes.en.title")?.value;
    expect(pushedTitle).toBe("Pushed title");
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);
    const revisionsAfterPush = await built.db.select({ id: sellableEntityRevisions.id }).from(sellableEntityRevisions).where(
      eq(sellableEntityRevisions.entityId, entityId),
    );

    const echo = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-hash-echo",
      type: "products/update",
      data: { id: "outbound-hash-product", title: pushedTitle, description: "Store description" },
    });
    expect(echo).toEqual({ ok: true, value: { processed: true } });
    const revisionsAfterEcho = await built.db.select({ id: sellableEntityRevisions.id }).from(sellableEntityRevisions).where(
      eq(sellableEntityRevisions.entityId, entityId),
    );
    expect(revisionsAfterEcho).toHaveLength(revisionsAfterPush.length);
    const [echoMapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths, outboundHash: channelEntityMap.outboundHash, outboundFieldPaths: channelEntityMap.outboundFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(echoMapping?.heldFieldPaths).not.toContain("attributes.en.title");
    const [echoStore] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(echoStore?.report).not.toMatchObject({ conflicts: expect.arrayContaining([expect.objectContaining({ fieldPath: "attributes.en.title" })]) });
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "platform", testAdminActor);

    await built.db.update(channelEntityMap).set({
      syncHash: "stale-baseline",
      outboundPushedAt: new Date(Date.now() - CATALOG_OUTBOUND_SUPPRESSION_WINDOW_MS - 1),
    }).where(eq(channelEntityMap.entityId, entityId));
    const expired = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-hash-expired",
      type: "products/update",
      data: { id: "outbound-hash-product", title: pushedTitle, description: "Store description" },
    });
    expect(expired).toEqual({ ok: true, value: { processed: true } });
    const [expiredMapping] = await built.db.select({ syncHash: channelEntityMap.syncHash }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(expiredMapping?.syncHash).not.toBe("stale-baseline");

    const changed = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-hash-merchant-change",
      type: "products/update",
      data: { id: "outbound-hash-product", title: "Merchant title", description: "Merchant description" },
    });
    expect(changed).toEqual({ ok: true, value: { processed: true } });
    const [attribute] = await built.db.select({ title: sellableAttributes.title, description: sellableAttributes.description }).from(sellableAttributes).where(
      and(eq(sellableAttributes.entityId, entityId), eq(sellableAttributes.locale, "en")),
    );
    expect(attribute).toEqual({ title: "Pushed title", description: "Merchant description" });
    const revisionsAfterChange = await built.db.select({ id: sellableEntityRevisions.id }).from(sellableEntityRevisions).where(
      eq(sellableEntityRevisions.entityId, entityId),
    );
    expect(revisionsAfterChange).toHaveLength(revisionsAfterEcho.length + 1);
  }, 30_000);

  it("normalizes the echoed platform value while converging a store-owned field in the same webhook", async () => {
    const pushed: ChannelPushCatalogItem[] = [];
    const connector = { ...mockChannelConnector({ onPushCatalog: (items) => pushed.push(...items) }), providerId: "shopify" };
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [connector] },
      built.kernel.database.transaction as PluginTxFn,
    );
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "shopify", credentials: {}, storeDomain: "outbound-normalized.test" }),
    });
    const storeId = (await response.json()).data.id as string;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const created = await built.kernel.services.catalog.create({
      type: "product",
      slug: "outbound-normalized-product",
      status: "active",
      metadata: {},
      attributes: { locale: "en", title: "  Pushed   title  ", description: "Initial description" },
    }, testAdminActor);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    const entityId = created.value.id;
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId,
      kind: "entity",
      externalId: "outbound-normalized-product",
      entityId,
      syncHash: "before-push",
    });
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "platform", testAdminActor);

    const pushedResult = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(pushedResult.ok).toBe(true);
    expect(pushed[0]?.fields.find((field) => field.fieldPath === "attributes.en.title")?.value).toBe("  Pushed   title  ");
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);
    const revisionsAfterPush = await built.db.select({ id: sellableEntityRevisions.id }).from(sellableEntityRevisions).where(
      eq(sellableEntityRevisions.entityId, entityId),
    );

    const handled = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-normalized-echo",
      type: "products/update",
      data: {
        id: "outbound-normalized-product",
        title: "Pushed title",
        description: "Merchant description",
      },
    });
    expect(handled).toEqual({ ok: true, value: { processed: true } });
    const [attribute] = await built.db.select({ title: sellableAttributes.title, description: sellableAttributes.description }).from(sellableAttributes).where(
      and(eq(sellableAttributes.entityId, entityId), eq(sellableAttributes.locale, "en")),
    );
    expect(attribute).toEqual({ title: "Pushed title", description: "Merchant description" });
    const revisionsAfterWebhook = await built.db.select({ id: sellableEntityRevisions.id }).from(sellableEntityRevisions).where(
      eq(sellableEntityRevisions.entityId, entityId),
    );
    expect(revisionsAfterWebhook).toHaveLength(revisionsAfterPush.length + 1);
    const [store] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(store?.report).not.toMatchObject({ conflicts: expect.anything() });
  }, 30_000);

  it("raises no shared conflict for an unchanged echo and detects a later shared edit after expiry", async () => {
    const connector = { ...mockChannelConnector(), providerId: "shopify" };
    const { built, service, storeId, entityId } = await createOutboundScenario("outbound-shared-window", connector);
    const pushed = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(pushed).toMatchObject({ ok: true, value: { outcomes: [{ ok: true }] } });
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);

    const echo = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-shared-echo",
      type: "products/update",
      data: { id: "outbound-shared-window", title: "Pushed title", description: "Store description" },
    });
    expect(echo).toEqual({ ok: true, value: { processed: true } });
    const [echoMapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(echoMapping?.heldFieldPaths).not.toContain("attributes.en.title");
    const [echoStore] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(echoStore?.report).not.toMatchObject({ conflicts: expect.arrayContaining([expect.objectContaining({ fieldPath: "attributes.en.title" })]) });

    await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local shared edit" }, testAdminActor);
    await built.db.update(channelEntityMap).set({
      outboundPushedAt: new Date(Date.now() - CATALOG_OUTBOUND_SUPPRESSION_WINDOW_MS - 1),
    }).where(eq(channelEntityMap.entityId, entityId));
    const later = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-shared-later",
      type: "products/update",
      data: { id: "outbound-shared-window", title: "Merchant shared edit", description: "Store description" },
    });
    expect(later).toEqual({ ok: true, value: { processed: true } });
    const [laterStore] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(laterStore?.report).toMatchObject({ conflicts: [expect.objectContaining({ fieldPath: "attributes.en.title" })] });
    const [laterMapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(laterMapping?.heldFieldPaths).toContain("attributes.en.title");
  }, 30_000);

  it("raises a conflict for a genuine shared edit riding inside an echo payload", async () => {
    const connector = { ...mockChannelConnector(), providerId: "shopify" };
    const { built, service, storeId, entityId } = await createOutboundScenario("outbound-echo-rider", connector);
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.description", storeId, "shared", testAdminActor);
    const pushed = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(pushed).toMatchObject({ ok: true, value: { outcomes: [{ ok: true }] } });
    await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Pushed title", description: "Local description edit" }, testAdminActor);

    const echo = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-echo-rider-webhook",
      type: "products/update",
      data: { id: "outbound-echo-rider", title: "Pushed title", description: "Merchant description" },
    });
    expect(echo).toEqual({ ok: true, value: { processed: true } });
    const [mapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.heldFieldPaths).toContain("attributes.en.description");
    expect(mapping?.heldFieldPaths).not.toContain("attributes.en.title");
    const [store] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(store?.report).toMatchObject({ conflicts: [expect.objectContaining({ fieldPath: "attributes.en.description" })] });
    const [attribute] = await built.db.select({ title: sellableAttributes.title, description: sellableAttributes.description }).from(sellableAttributes).where(
      and(eq(sellableAttributes.entityId, entityId), eq(sellableAttributes.locale, "en")),
    );
    expect(attribute).toEqual({ title: "Pushed title", description: "Local description edit" });
  }, 30_000);

  it("converges an unchanged-value shared field inside an echo without a conflict", async () => {
    const connector = { ...mockChannelConnector(), providerId: "shopify" };
    const { built, service, storeId, entityId } = await createOutboundScenario("outbound-echo-benign", connector);
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.description", storeId, "shared", testAdminActor);
    const pushed = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(pushed).toMatchObject({ ok: true, value: { outcomes: [{ ok: true }] } });
    await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Pushed title", description: "Local description edit" }, testAdminActor);

    const echo = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-echo-benign-webhook",
      type: "products/update",
      data: { id: "outbound-echo-benign", title: "Pushed title", description: "Local description edit" },
    });
    expect(echo).toEqual({ ok: true, value: { processed: true } });
    const [mapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.heldFieldPaths ?? []).not.toContain("attributes.en.description");
    const [store] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(store?.report).not.toMatchObject({ conflicts: expect.arrayContaining([expect.objectContaining({ fieldPath: "attributes.en.description" })]) });
  }, 30_000);

  it("suppresses a normalized custom-field echo using the pushed field path", async () => {
    const connector = { ...mockChannelConnector(), providerId: "shopify" };
    const { built, service, storeId, entityId } = await createOutboundScenario("outbound-custom-field", connector);
    const definition = await built.kernel.services.catalog.createEntityFieldDefinition({
      entityType: "product",
      name: "material",
      type: "text",
      filterable: true,
    }, testAdminActor);
    expect(definition.ok).toBe(true);
    await built.db.insert(sellableCustomFields).values({
      entityId,
      fieldName: "material",
      fieldType: "text",
      source: "merchant",
      status: "approved",
      locale: "en",
      textValue: "  linen  ",
    });
    await built.kernel.services.catalog.setFieldOwner(entityId, "customFields.material.en", storeId, "platform", testAdminActor);
    const pushed = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(pushed).toMatchObject({ ok: true, value: { outcomes: [{ ok: true }] } });
    await built.kernel.services.catalog.setFieldOwner(entityId, "customFields.material.en", storeId, "shared", testAdminActor);
    const handled = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "outbound-custom-field-echo",
      type: "products/update",
      data: {
        id: "outbound-custom-field",
        customFields: { material: { en: "linen" } },
      },
    });
    expect(handled).toEqual({ ok: true, value: { processed: true } });
    const [mapping] = await built.db.select({ outboundFieldPaths: channelEntityMap.outboundFieldPaths, heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.outboundFieldPaths).toContain("customFields.material.en");
    expect(mapping?.heldFieldPaths).not.toContain("customFields.material.en");
    const [store] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(store?.report).not.toMatchObject({ conflicts: expect.arrayContaining([expect.objectContaining({ fieldPath: "customFields.material.en" })]) });
  }, 30_000);

  it("treats the suppression window boundary as inclusive", async () => {
    const connector = { ...mockChannelConnector(), providerId: "shopify" };
    const { built, service, storeId, entityId } = await createOutboundScenario("outbound-window-boundary", connector);
    await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);
    const [mapping] = await built.db.select({ outboundPushedAt: channelEntityMap.outboundPushedAt }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.outboundPushedAt).toBeInstanceOf(Date);
    const boundary = mapping!.outboundPushedAt!.getTime() + CATALOG_OUTBOUND_SUPPRESSION_WINDOW_MS;
    vi.setSystemTime(boundary);
    try {
      const echo = await service.handleWebhook(TEST_ORG_ID, storeId, {
        id: "outbound-boundary-echo",
        type: "products/update",
        data: { id: "outbound-window-boundary", title: "Pushed title", description: "Store description" },
      });
      expect(echo).toEqual({ ok: true, value: { processed: true } });
      const [boundaryMapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
      expect(boundaryMapping?.heldFieldPaths).not.toContain("attributes.en.title");

      await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local boundary edit" }, testAdminActor);
      vi.setSystemTime(boundary + 1);
      const expired = await service.handleWebhook(TEST_ORG_ID, storeId, {
        id: "outbound-boundary-expired",
        type: "products/update",
        data: { id: "outbound-window-boundary", title: "Boundary merchant edit", description: "Store description" },
      });
      expect(expired).toEqual({ ok: true, value: { processed: true } });
      const [store] = await built.db.select({ report: connectedStores.lastReconcileReport }).from(connectedStores).where(eq(connectedStores.id, storeId));
      expect(store?.report).toMatchObject({ conflicts: [expect.objectContaining({ fieldPath: "attributes.en.title" })] });
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("suppresses the echo on the reconcile path", async () => {
    const remote: ChannelCatalogItem = {
      externalId: "outbound-reconcile-echo",
      slug: "outbound-reconcile-echo",
      title: "Pushed title",
      attributes: [{ locale: "en", title: "Pushed title", description: "Store description" }],
      variants: [],
    };
    const connector = { ...mockChannelConnector({ catalog: [remote] }), providerId: "shopify" };
    const { built, service, storeId, entityId } = await createOutboundScenario("outbound-reconcile-echo", connector);
    await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);
    const before = await built.db.select({ id: sellableEntityRevisions.id }).from(sellableEntityRevisions).where(eq(sellableEntityRevisions.entityId, entityId));
    const reconciled = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw reconciled.error;
    expect(reconciled.value).not.toHaveProperty("conflicts");
    const after = await built.db.select({ id: sellableEntityRevisions.id }).from(sellableEntityRevisions).where(eq(sellableEntityRevisions.entityId, entityId));
    expect(after).toHaveLength(before.length);
    const [mapping] = await built.db.select({ syncHash: channelEntityMap.syncHash, heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.syncHash).not.toBe("before-push");
    expect(mapping?.heldFieldPaths).not.toContain("attributes.en.title");
  }, 30_000);

  it("clears write-ahead state after a failed push that received an echo", async () => {
    const remote = {
      externalId: "outbound-failed-recovery",
      slug: "outbound-failed-recovery",
      title: "Pushed title",
      attributes: [{ locale: "en", title: "Pushed title", description: "Store description" }],
      variants: [],
    };
    let pushService: ChannelConnectorService | undefined;
    const base = mockChannelConnector({ catalog: [remote] });
    const connector: ChannelConnector = {
      ...base,
      providerId: "shopify",
      async pushCatalog(store, items) {
        const item = items[0];
        if (!item || !pushService) throw new Error("Push test service was not initialized.");
        const title = item.fields.find((field) => field.fieldPath === "attributes.en.title")?.value;
        const switched = await builtForPush!.kernel.services.catalog.setFieldOwner(pushEntityId!, "attributes.en.title", pushStoreId!, "shared", testAdminActor);
        expect(switched.ok).toBe(true);
        const echo = await pushService.handleWebhook(TEST_ORG_ID, store.id, {
          id: "outbound-failed-recovery-echo",
          type: "products/update",
          data: { id: item.externalId, title, description: "Store description" },
        });
        expect(echo).toEqual({ ok: true, value: { processed: true } });
        return { ok: true, value: { outcomes: [{ externalId: item.externalId, ok: false, error: { code: "REMOTE_FAILED", message: "Rejected." } }] } };
      },
    };
    let builtForPush: Awaited<ReturnType<typeof createPluginTestApp>> | undefined;
    let pushStoreId: string | undefined;
    let pushEntityId: string | undefined;
    const scenario = await createOutboundScenario("outbound-failed-recovery", connector);
    builtForPush = scenario.built;
    pushStoreId = scenario.storeId;
    pushEntityId = scenario.entityId;
    pushService = scenario.service;
    const failed = await scenario.service.pushCatalogToStore(TEST_ORG_ID, scenario.storeId, [scenario.entityId]);
    expect(failed).toMatchObject({ ok: true, value: { outcomes: [{ ok: false }] } });
    const [cleared] = await scenario.built.db.select({ syncHash: channelEntityMap.syncHash, outboundHash: channelEntityMap.outboundHash, outboundPushedAt: channelEntityMap.outboundPushedAt, outboundFieldPaths: channelEntityMap.outboundFieldPaths, heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, scenario.entityId));
    expect(cleared).toEqual({ syncHash: "", outboundHash: null, outboundPushedAt: null, outboundFieldPaths: [], heldFieldPaths: [] });
    await scenario.built.kernel.services.catalog.setAttributes(scenario.entityId, "en", { title: "Local after failed push" }, testAdminActor);
    const reconciled = await scenario.service.reconcile(TEST_ORG_ID, scenario.storeId, createSystemActor(TEST_ORG_ID));
    expect(reconciled).toMatchObject({ ok: true, value: { openConflicts: 0 } });
    if (reconciled.ok) expect(reconciled.value.conflicts ?? []).toEqual([]);
  }, 30_000);

  it("clears write-ahead state when the connector throws", async () => {
    const base = mockChannelConnector();
    const connector: ChannelConnector = {
      ...base,
      providerId: "shopify",
      async pushCatalog() {
        throw new Error("transport exploded");
      },
    };
    const { built, service, storeId, entityId } = await createOutboundScenario("outbound-thrown-connector", connector);
    const result = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(result).toEqual({ ok: false, error: "transport exploded", code: "CATALOG_PUSH_THROWN" });
    const [mapping] = await built.db.select({ syncHash: channelEntityMap.syncHash, outboundHash: channelEntityMap.outboundHash, outboundPushedAt: channelEntityMap.outboundPushedAt, outboundFieldPaths: channelEntityMap.outboundFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping).toEqual({ syncHash: "", outboundHash: null, outboundPushedAt: null, outboundFieldPaths: [] });
  }, 30_000);
});
