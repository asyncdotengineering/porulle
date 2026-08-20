import { describe, expect, it } from "vitest";
import { createSystemActor, type ChannelCatalogItem, type PluginTxFn } from "@porulle/core";
import { and, eq } from "@porulle/core/drizzle";
import { organization } from "@porulle/core/auth-schema";
import { commerceJobs, sellableAttributes, sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID, testAdminActor } from "@porulle/core/testing";
import { channelConnectorPlugin, ChannelConnectorService, mockChannelConnector } from "../src/index.js";
import { channelCatalogConflictEvents, channelCatalogConflicts, channelEntityMap } from "../src/schema.js";

const OTHER_ORG_ID = "catalog_conflicts_other_org";
const otherActor = { ...testAdminActor, userId: "catalog-conflicts-other", email: "catalog-conflicts-other@test.local", organizationId: OTHER_ORG_ID };

async function createImportedScenario(connectorOptions: Record<string, unknown> = {}) {
  const item: ChannelCatalogItem = {
    externalId: `conflict-product-${crypto.randomUUID()}`,
    slug: `conflict-product-${crypto.randomUUID()}`,
    title: "Original title",
    status: "active",
    attributes: [{ locale: "en", title: "Original title", subtitle: "Original subtitle", description: "Original description" }],
    variants: [],
  };
  item.slug = item.externalId;
  const connector = mockChannelConnector({ catalog: [item], ...connectorOptions });
  const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
  const service = new ChannelConnectorService(
    built.db,
    built.kernel.services,
    { connectors: [connector] },
    built.kernel.database.transaction as PluginTxFn,
  );
  const storeResponse = await built.app.request("http://localhost/api/channels/stores", {
    method: "POST",
    headers: jsonHeaders(testAdminActor),
    body: JSON.stringify({ provider: "mock", credentials: {}, storeDomain: `${item.externalId}.test` }),
  });
  expect(storeResponse.status).toBe(201);
  const storeId = (await storeResponse.json()).data.id as string;
  const imported = await service.importCatalog(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
  expect(imported).toMatchObject({ ok: true, value: { imported: 1 } });
  const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.slug, item.slug));
  expect(entity).toBeDefined();
  return { built, service, storeId, entityId: entity!.id, item };
}

async function createConflictScenario(connectorOptions: Record<string, unknown> = {}) {
  const { built, service, storeId, entityId, item } = await createImportedScenario(connectorOptions);
  const shared = await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.title", storeId, "shared", testAdminActor);
  expect(shared).toEqual({ ok: true, value: undefined });
  const local = await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local title" }, testAdminActor);
  expect(local).toEqual({ ok: true, value: undefined });
  item.attributes = [{ locale: "en", title: "Remote title" }];
  const reconciled = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
  expect(reconciled).toMatchObject({ ok: true, value: { conflicts: [{ fieldPath: "attributes.en.title" }], openConflicts: 1 } });
  const [conflict] = await built.db.select().from(channelCatalogConflicts).where(eq(channelCatalogConflicts.storeId, storeId));
  expect(conflict).toBeDefined();
  return { built, service, storeId, entityId, conflict: conflict!, item };
}

describe("channel catalog conflicts", () => {
  it("persists both values and writes neither side when a shared field conflicts", async () => {
    const { built, conflict, entityId, storeId } = await createConflictScenario();
    expect(conflict).toMatchObject({
      organizationId: TEST_ORG_ID,
      storeId,
      entityId,
      fieldPath: "attributes.en.title",
      platformValue: "Local title",
      storeValue: "Remote title",
      state: "open",
    });
    const [attribute] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(attribute?.title).toBe("Local title");
  }, 30_000);

  it("resolving for the platform closes the conflict, clears the hold, and enqueues the entity push", async () => {
    const { built, conflict, entityId, service, storeId } = await createConflictScenario();
    const response = await built.app.request(`http://localhost/api/channels/conflicts/${conflict.id}/resolve`, {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ choose: "platform" }),
    });

    expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({ id: conflict.id, state: "resolved", resolvedBy: testAdminActor.userId });
    const [resolved] = await built.db.select().from(channelCatalogConflicts).where(eq(channelCatalogConflicts.id, conflict.id));
    expect(resolved?.state).toBe("resolved");
    const events = await built.db.select().from(channelCatalogConflictEvents).where(eq(channelCatalogConflictEvents.conflictId, conflict.id));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromState: null, toState: "open" }),
      expect.objectContaining({ fromState: "open", toState: "resolved", changedBy: testAdminActor.userId }),
    ]));
    const [mapping] = await built.db.select({
      heldFieldPaths: channelEntityMap.heldFieldPaths,
      forcedPushFieldPaths: channelEntityMap.forcedPushFieldPaths,
    }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.heldFieldPaths).not.toContain("attributes.en.title");
    expect(mapping?.forcedPushFieldPaths).toContain("attributes.en.title");
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    await service.updateCatalogFieldMapping(TEST_ORG_ID, storeId, [{
      fieldPath: "attributes.*.title",
      provider: "mock",
      target: "native",
      remoteKey: "title",
    }]);
    const push = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);
    expect(push).toMatchObject({ ok: true, value: { items: [{ fields: [expect.objectContaining({ fieldPath: "attributes.en.title" })] }] } });
    if (push.ok) expect(push.value.skipped).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId, fieldPath: "attributes.en.title", reason: "held" }),
    ]));
    const pushed = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(pushed).toMatchObject({ ok: true });
    const [cleared] = await built.db.select({ forcedPushFieldPaths: channelEntityMap.forcedPushFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(cleared?.forcedPushFieldPaths).not.toContain("attributes.en.title");
    const jobs = await built.db.select().from(commerceJobs).where(eq(commerceJobs.taskSlug, "channel/push-catalog"));
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        organizationId: TEST_ORG_ID,
        input: expect.objectContaining({ organizationId: TEST_ORG_ID, storeId, entityIds: [entityId] }),
      }),
    ]));
    const reopened = await built.db.insert(channelCatalogConflicts).values({
      organizationId: TEST_ORG_ID,
      storeId,
      entityId,
      fieldPath: conflict.fieldPath,
      platformValue: "Another platform value",
      storeValue: "Another store value",
    }).returning();
    expect(reopened[0]?.state).toBe("open");
  }, 30_000);

  it("raises a new conflict when both sides change a shared field after platform resolution", async () => {
    const { built, conflict, entityId, item, service, storeId } = await createConflictScenario();
    const response = await built.app.request(`http://localhost/api/channels/conflicts/${conflict.id}/resolve`, {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ choose: "platform" }),
    });
    expect(response.status).toBe(201);

    const local = await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local title 2" }, testAdminActor);
    expect(local).toEqual({ ok: true, value: undefined });
    item.attributes = [{ locale: "en", title: "Remote title 2" }];
    const reconciled = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));

    expect(reconciled).toMatchObject({
      ok: true,
      value: { conflicts: [{ fieldPath: "attributes.en.title" }], openConflicts: 1 },
    });
    const open = await built.db.select().from(channelCatalogConflicts).where(and(
      eq(channelCatalogConflicts.storeId, storeId),
      eq(channelCatalogConflicts.state, "open"),
    ));
    expect(open).toHaveLength(1);
  }, 30_000);

  it("resolving for the store writes the saved remote value and allows later convergence", async () => {
    const { built, conflict, entityId, item, service, storeId } = await createConflictScenario();
    const response = await built.app.request(`http://localhost/api/channels/conflicts/${conflict.id}/resolve`, {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ choose: "store" }),
    });

    expect(response.status).toBe(201);
    const [afterResolution] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(afterResolution?.title).toBe("Remote title");
    const [mapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.heldFieldPaths).not.toContain("attributes.en.title");

    item.attributes = [{ locale: "en", title: "Remote after resolution" }];
    const converged = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(converged).toMatchObject({ ok: true });
    const [afterConvergence] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(afterConvergence?.title).toBe("Remote after resolution");

    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    await service.updateCatalogFieldMapping(TEST_ORG_ID, storeId, [{
      fieldPath: "attributes.*.title",
      provider: "mock",
      target: "native",
      remoteKey: "title",
    }]);
    const push = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);
    expect(push).toMatchObject({
      ok: true,
      value: { items: [{ fields: [] }] },
    });
    if (push.ok) expect(push.value.skipped).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId, fieldPath: "attributes.en.title", reason: "store_owned" }),
    ]));
    if (push.ok) expect(push.value.skipped).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId, fieldPath: "attributes.en.title", reason: "held" }),
    ]));
  }, 30_000);

  it("keeps shared ownership after store resolution so later platform edits can push", async () => {
    const { built, conflict, entityId, service, storeId } = await createConflictScenario();
    const response = await built.app.request(`http://localhost/api/channels/conflicts/${conflict.id}/resolve`, {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ choose: "store" }),
    });
    expect(response.status).toBe(201);

    const owners = await built.kernel.services.catalog.resolveFieldOwners(entityId, storeId);
    expect(owners.get("attributes.en.title")).toBe("shared");
    const local = await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local title after store resolution" }, testAdminActor);
    expect(local).toEqual({ ok: true, value: undefined });
    const jobs = await built.db.select().from(commerceJobs).where(eq(commerceJobs.taskSlug, "channel/push-catalog"));
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        input: expect.objectContaining({ forceFieldPaths: { [entityId]: ["attributes.en.title"] } }),
      }),
    ]));
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    await service.updateCatalogFieldMapping(TEST_ORG_ID, storeId, [{
      fieldPath: "attributes.*.title",
      provider: "mock",
      target: "native",
      remoteKey: "title",
    }]);
    const push = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId], {
      forceFieldPaths: { [entityId]: ["attributes.en.title"] },
    });
    expect(push).toMatchObject({
      ok: true,
      value: { items: [{ fields: [expect.objectContaining({ fieldPath: "attributes.en.title" })] }] },
    });
    if (push.ok) expect(push.value.skipped).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId, fieldPath: "attributes.en.title", reason: "store_owned" }),
    ]));
  }, 30_000);

  it("does not queue a conflict or hold a shared path when only other paths changed", async () => {
    const { built, entityId, item, service, storeId } = await createImportedScenario();
    for (const fieldPath of ["attributes.en.title", "attributes.en.subtitle", "attributes.en.description"] as const) {
      const shared = await built.kernel.services.catalog.setFieldOwner(entityId, fieldPath, storeId, "shared", testAdminActor);
      expect(shared).toEqual({ ok: true, value: undefined });
    }
    const local = await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local title only" }, testAdminActor);
    expect(local).toEqual({ ok: true, value: undefined });
    item.attributes = [{ locale: "en", title: "Original title", subtitle: "Remote subtitle only", description: "Original description" }];

    const reconciled = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(reconciled).toMatchObject({ ok: true, value: { openConflicts: 0 } });
    if (reconciled.ok) expect(reconciled.value.conflicts ?? []).toEqual([]);
    const [mapping] = await built.db.select({ heldFieldPaths: channelEntityMap.heldFieldPaths }).from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(mapping?.heldFieldPaths ?? []).toEqual([]);
    const conflicts = await built.db.select().from(channelCatalogConflicts).where(eq(channelCatalogConflicts.entityId, entityId));
    expect(conflicts).toEqual([]);
    const [attributes] = await built.db.select().from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(attributes).toMatchObject({ title: "Original title", subtitle: "Remote subtitle only", description: "Original description" });
  }, 30_000);

  it("refreshes an open conflict with the newest remote value before resolution", async () => {
    const { built, conflict, entityId, item, service, storeId } = await createConflictScenario();
    const firstCreatedAt = conflict.createdAt;
    item.attributes = [{ locale: "en", title: "Remote title newer" }];

    const refreshed = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(refreshed).toMatchObject({ ok: true });
    const [updated] = await built.db.select().from(channelCatalogConflicts).where(eq(channelCatalogConflicts.id, conflict.id));
    expect(updated).toMatchObject({ storeValue: "Remote title newer", createdAt: firstCreatedAt });

    const response = await service.resolveCatalogConflict(TEST_ORG_ID, conflict.id, "store", testAdminActor);
    expect(response).toMatchObject({ ok: true });
    const [attribute] = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entityId));
    expect(attribute?.title).toBe("Remote title newer");
  }, 30_000);

  it("scopes conflict listing and resolution to the authenticated organization", async () => {
    const { built, conflict, storeId } = await createConflictScenario();
    await built.db.insert(organization).values({
      id: OTHER_ORG_ID,
      name: "Catalog Conflicts Other",
      slug: "catalog-conflicts-other",
      createdAt: new Date(),
    });

    const ownList = await built.app.request(`http://localhost/api/channels/conflicts?storeId=${storeId}&state=open`, {
      headers: jsonHeaders(testAdminActor),
    });
    expect(ownList.status).toBe(200);
    expect((await ownList.json()).data).toEqual([expect.objectContaining({ id: conflict.id, organizationId: TEST_ORG_ID })]);

    const foreignList = await built.app.request(`http://localhost/api/channels/conflicts?storeId=${storeId}&state=open`, {
      headers: jsonHeaders(otherActor),
    });
    expect(foreignList.status).toBe(200);
    expect((await foreignList.json()).data).toEqual([]);

    const foreignResolve = await built.app.request(`http://localhost/api/channels/conflicts/${conflict.id}/resolve`, {
      method: "POST",
      headers: jsonHeaders(otherActor),
      body: JSON.stringify({ choose: "store" }),
    });
    expect(foreignResolve.status).toBe(404);
  }, 30_000);

  it("does not let a stale force from an earlier resolution bypass a new conflict", async () => {
    const { built, service, storeId, entityId, conflict, item } = await createConflictScenario();

    const resolved = await service.resolveCatalogConflict(TEST_ORG_ID, conflict.id, "platform", testAdminActor);
    expect(resolved.ok).toBe(true);
    const [afterResolve] = await built.db.select().from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(afterResolve?.forcedPushFieldPaths).toContain("attributes.en.title");

    // The forced push has not run yet. Both sides move again, raising a NEW
    // conflict on the same field that no operator has answered.
    await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local title 2" }, testAdminActor);
    item.attributes = [{ locale: "en", title: "Remote title 2" }];
    const second = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(second).toMatchObject({ ok: true, value: { openConflicts: 1 } });

    const [afterSecond] = await built.db.select().from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(afterSecond?.heldFieldPaths).toContain("attributes.en.title");
    // The stale force must be revoked, not merely out-ranked.
    expect(afterSecond?.forcedPushFieldPaths ?? []).not.toContain("attributes.en.title");

    // And the field must not reach the store while a conflict is open.
    expect((await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true)).ok).toBe(true);
    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);
    expect(assembled.ok).toBe(true);
    if (assembled.ok) {
      const pushedPaths = assembled.value.items.flatMap((pushItem) => pushItem.fields.map((field) => field.fieldPath));
      expect(pushedPaths).not.toContain("attributes.en.title");
      // Note: a shared-owned field returns before the held check, so no skip
      // entry is recorded. That reporting gap is pre-existing for shared fields
      // generally; what matters here is that the value does not reach the store.
    }
  }, 30_000);

  it("revokes a stale force when a webhook raises the new conflict", async () => {
    const { built, service, storeId, entityId, conflict, item } = await createConflictScenario();

    expect((await service.resolveCatalogConflict(TEST_ORG_ID, conflict.id, "platform", testAdminActor)).ok).toBe(true);
    const [afterResolve] = await built.db.select().from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(afterResolve?.forcedPushFieldPaths).toContain("attributes.en.title");

    // The new conflict arrives through the webhook path, not a full reconcile.
    // That path writes heldFieldPaths too and must revoke the stale force.
    await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local title 2" }, testAdminActor);
    const hook = await service.handleWebhook(TEST_ORG_ID, storeId, {
      id: "conflict-webhook-revoke",
      type: "products/update",
      data: { id: item.externalId, title: "Remote title 2" },
    });
    expect(hook).toEqual({ ok: true, value: { processed: true } });

    const [afterHook] = await built.db.select().from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(afterHook?.heldFieldPaths).toContain("attributes.en.title");
    expect(afterHook?.forcedPushFieldPaths ?? []).not.toContain("attributes.en.title");
  }, 30_000);

  it("keeps the force when the push fails so the resolution survives a retry", async () => {
    const { built, service, storeId, entityId, conflict } = await createConflictScenario({
      pushCatalogTransportError: { code: "REMOTE_DOWN", message: "Remote unavailable.", retriable: true },
    });

    expect((await service.resolveCatalogConflict(TEST_ORG_ID, conflict.id, "platform", testAdminActor)).ok).toBe(true);
    expect((await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true)).ok).toBe(true);
    expect((await service.updateCatalogFieldMapping(TEST_ORG_ID, storeId, [
      { fieldPath: "attributes.*.title", provider: "mock", target: "native", remoteKey: "title" },
    ])).ok).toBe(true);

    // The write-ahead runs before the connector is called and its outcomes are
    // optimistic. A failed push must not consume the operator's resolution.
    const failed = await service.pushCatalogToStore(TEST_ORG_ID, storeId, [entityId]);
    expect(failed.ok).toBe(false);

    const [afterFailure] = await built.db.select().from(channelEntityMap).where(eq(channelEntityMap.entityId, entityId));
    expect(afterFailure?.forcedPushFieldPaths ?? []).toContain("attributes.en.title");
  }, 30_000);

  it("blocks a field that is somehow both held and forced", async () => {
    const { built, service, storeId, entityId } = await createConflictScenario();
    expect((await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true)).ok).toBe(true);
    expect((await service.updateCatalogFieldMapping(TEST_ORG_ID, storeId, [
      { fieldPath: "attributes.*.title", provider: "mock", target: "native", remoteKey: "title" },
    ])).ok).toBe(true);

    // Force the pathological state directly: a hold must always beat a force,
    // whatever sequence produced it.
    await built.db.update(channelEntityMap).set({
      heldFieldPaths: ["attributes.en.title"],
      forcedPushFieldPaths: ["attributes.en.title"],
    }).where(eq(channelEntityMap.entityId, entityId));

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);
    expect(assembled.ok).toBe(true);
    if (assembled.ok) {
      const pushedPaths = assembled.value.items.flatMap((pushItem) => pushItem.fields.map((field) => field.fieldPath));
      expect(pushedPaths).not.toContain("attributes.en.title");
    }
  }, 30_000);

  it("refreshes the platform value on an open conflict when the local side changes again", async () => {
    const { built, service, storeId, entityId, item } = await createConflictScenario();

    await built.kernel.services.catalog.setAttributes(entityId, "en", { title: "Local title 2" }, testAdminActor);
    item.attributes = [{ locale: "en", title: "Remote title 2" }];
    const second = await service.reconcile(TEST_ORG_ID, storeId, createSystemActor(TEST_ORG_ID));
    expect(second).toMatchObject({ ok: true, value: { openConflicts: 1 } });

    const [row] = await built.db.select().from(channelCatalogConflicts).where(and(
      eq(channelCatalogConflicts.storeId, storeId),
      eq(channelCatalogConflicts.state, "open"),
    ));
    // The row is the operator's decision surface; both sides must be current.
    expect(row?.storeValue).toContain("Remote title 2");
    expect(row?.platformValue).toContain("Local title 2");
  }, 30_000);

  it("enforces organization scoping at the service boundary", async () => {
    const { built, service, conflict, storeId } = await createConflictScenario();
    await built.db.insert(organization).values({
      id: OTHER_ORG_ID,
      name: "Catalog Conflicts Service Other",
      slug: "catalog-conflicts-service-other",
      createdAt: new Date(),
    });
    const foreignList = await service.listCatalogConflicts(OTHER_ORG_ID, storeId);
    expect(foreignList).toMatchObject({ ok: true, value: [] });

    const foreignResolve = await service.resolveCatalogConflict(OTHER_ORG_ID, conflict.id, "platform", otherActor);
    expect(foreignResolve).toMatchObject({ ok: false, error: "Catalog conflict not found or already resolved." });
  }, 30_000);
});
