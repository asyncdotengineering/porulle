import { beforeAll, describe, expect, it } from "vitest";
import {
  type ChannelConnectorError,
  type ChannelPushCatalogItem,
  type Actor,
  type PluginTxFn,
} from "@porulle/core";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { eq } from "@porulle/core/drizzle";
import {
  entityMedia,
  mediaAssets,
  sellableCustomFields,
  sellableEntityRevisions,
} from "@porulle/core/schema";
import {
  channelConnectorPlugin,
  ChannelConnectorService,
  isValidCatalogMappingFieldPath,
  matchFieldPath,
  mergeCatalogFieldMapping,
  mockChannelConnector,
  selectCatalogFieldMapping,
  type CatalogFieldMapping,
} from "../src/index.js";
import { channelEntityMap, connectedStores } from "../src/schema.js";

const pushStore = {
  id: "00000000-0000-4000-8000-000000000002",
  organizationId: TEST_ORG_ID,
  provider: "mock" as const,
  credentials: {},
  storeDomain: "push.mock.channel.test",
  status: "connected" as const,
  webhookSecret: null,
};

const pushItems: ChannelPushCatalogItem[] = [
  {
    externalId: "push-product-1",
    fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "First product" }],
  },
  {
    externalId: "push-product-2",
    variants: [{
      externalId: "push-variant-2",
      fields: [{ fieldPath: "customFields.color.en", intent: "filterable", value: "blue" }],
    }],
    fields: [{ fieldPath: "entity.metadata.collection", intent: "tag", value: "summer" }],
  },
];

const actor: Actor = {
  type: "user",
  userId: "catalog-write-admin",
  email: "catalog-write-admin@test.local",
  name: "Catalog Write Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000099";

function providerConnector(providerId: "shopify" | "woocommerce") {
  return { ...mockChannelConnector({ catalog: [] }), providerId };
}

describe("channel catalog write settings", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let service: ChannelConnectorService;

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({
      connectors: [
        mockChannelConnector({ catalog: [] }),
        providerConnector("shopify"),
        providerConnector("woocommerce"),
      ],
    }));
    service = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [
        mockChannelConnector({ catalog: [] }),
        providerConnector("shopify"),
        providerConnector("woocommerce"),
      ] },
      built.kernel.database.transaction as PluginTxFn,
    );
  }, 30_000);

  async function connect(provider: "mock" | "shopify" | "woocommerce", domain: string) {
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(actor),
      body: JSON.stringify({
        provider,
        credentials: { accessToken: domain },
        storeDomain: domain,
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).data as { id: string };
  }

  async function update(storeId: string, body: Record<string, unknown>) {
    return built.app.request(`http://localhost/api/channels/stores/${storeId}/catalog-write`, {
      method: "PUT",
      headers: jsonHeaders(actor),
      body: JSON.stringify(body),
    });
  }

  it("defaults to disabled and toggles write access per store", async () => {
    const store = await connect("mock", "catalog-write-toggle.mock.test");
    const initial = await built.app.request(`http://localhost/api/channels/stores/${store.id}/catalog-write`, {
      headers: jsonHeaders(actor),
    });
    expect(initial.status).toBe(200);
    expect((await initial.json()).data).toMatchObject({ enabled: false, overrides: [], merged: [] });

    const updated = await update(store.id, { enabled: true });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({ enabled: true, overrides: [], merged: [] });
  });

  it("merges provider defaults at read time and preserves overrides while reconnecting", async () => {
    const store = await connect("shopify", "catalog-write-reconnect.myshopify.com");
    const [record] = await built.db.select().from(connectedStores).where(eq(connectedStores.id, store.id));
    expect(record?.catalogFieldMapping).toEqual([]);

    const initial = await built.app.request(`http://localhost/api/channels/stores/${store.id}/catalog-write`, {
      headers: jsonHeaders(actor),
    });
    const initialData = (await initial.json()).data;
    expect(initialData.overrides).toEqual([]);
    expect(initialData.merged).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "attributes.*.title", target: "native", provider: "shopify" }),
    ]));

    const overrides = [{
      fieldPath: "attributes.*.title",
      provider: "shopify",
      target: "meta",
      remoteKey: "custom_title",
    }];
    const saved = await update(store.id, { overrides });
    expect(saved.status).toBe(200);
    const savedData = (await saved.json()).data;
    expect(savedData).toMatchObject({ overrides });
    expect(savedData.merged).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "attributes.*.title", target: "meta", remoteKey: "custom_title" }),
      expect.objectContaining({ fieldPath: "attributes.*.seoTitle", target: "meta" }),
    ]));

    const [updatedRecord] = await built.db.select().from(connectedStores).where(eq(connectedStores.id, store.id));
    expect(updatedRecord?.catalogFieldMapping).toEqual(overrides);
    const customFieldResolution = service.resolveCatalogFieldMapping(updatedRecord!, {
      "customFields.material.en": true,
      "customFields.color.en": false,
    });
    expect(customFieldResolution).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "customFields.material.en", target: "attribute", remoteKey: "material" }),
      expect.objectContaining({ fieldPath: "customFields.color.en", target: "meta", remoteKey: "color" }),
    ]));

    const enabled = await update(store.id, { enabled: true });
    expect(enabled.status).toBe(200);
    const disconnected = await built.app.request(`http://localhost/api/channels/stores/${store.id}/disconnect`, {
      method: "POST",
      headers: jsonHeaders(actor),
    });
    expect(disconnected.status).toBe(201);
    const reconnected = await connect("shopify", "catalog-write-reconnect.myshopify.com");
    expect(reconnected.id).toBe(store.id);
    const [afterReconnect] = await built.db.select().from(connectedStores).where(eq(connectedStores.id, store.id));
    expect(afterReconnect?.catalogWriteEnabled).toBe(false);
    expect(afterReconnect?.catalogFieldMapping).toEqual(overrides);

    const afterReconnectSettings = await built.app.request(`http://localhost/api/channels/stores/${store.id}/catalog-write`, {
      headers: jsonHeaders(actor),
    });
    expect((await afterReconnectSettings.json()).data).toMatchObject({ enabled: false, overrides });
  });

  it("accepts wildcard mappings and rejects forbidden roots, descendants, and wildcard expansions", async () => {
    const store = await connect("woocommerce", "catalog-write-validation.woo.test");
    const valid = await update(store.id, { overrides: [{
      fieldPath: "attributes.*.title",
      provider: "woocommerce",
      target: "native",
      remoteKey: "name",
    }] });
    expect(valid.status).toBe(200);

    for (const fieldPath of [
      "variants.sku",
      "variants.barcode",
      "variants.*",
      "options",
      "options.color",
      "prices",
      "prices.EUR",
      "prices.*",
      "*.sku",
    ]) {
      const response = await update(store.id, { overrides: [{
        fieldPath,
        provider: "woocommerce",
        target: "native",
        remoteKey: "remote",
      }] });
      expect(response.status, fieldPath).toBe(422);
    }

    const underscore = await update(store.id, { overrides: [{
      fieldPath: "entity.metadata.internal",
      provider: "woocommerce",
      target: "meta",
      remoteKey: " _internal",
    }] });
    expect(underscore.status).toBe(422);
  });

  it("trims remote keys and allows underscore-prefixed Shopify metafields", async () => {
    const store = await connect("shopify", "catalog-write-shopify-meta.myshopify.com");
    const response = await update(store.id, { overrides: [{
      fieldPath: "entity.metadata.internal",
      provider: "shopify",
      target: "meta",
      remoteKey: " _internal ",
    }] });
    expect(response.status).toBe(200);
    expect((await response.json()).data.overrides).toEqual([expect.objectContaining({ remoteKey: "_internal" })]);
  });

  it("anchors wildcard matching and rejects partial segments", () => {
    expect(matchFieldPath("attributes.*.title", "attributes.en.title")).toBe(true);
    expect(matchFieldPath("attributes.*.title", "attributes.en.description")).toBe(false);
    expect(matchFieldPath("attributes.*.title", "attributes.en.title.extra")).toBe(false);
    expect(matchFieldPath("attributes.*.title", "xattributes.en.title")).toBe(false);
    expect(matchFieldPath("attributes.*.title", "attributes.en.titleExtra")).toBe(false);
    expect(matchFieldPath("attributes.*.title", "attributes..title")).toBe(false);
    expect(matchFieldPath("attributes.*title", "attributes.entitle")).toBe(false);
    expect(isValidCatalogMappingFieldPath("attributes.*.title")).toBe(true);
    expect(isValidCatalogMappingFieldPath("attributes.*title")).toBe(false);
  });

  it("selects the most concrete matching pattern with a deterministic tie-break", () => {
    const mapping: CatalogFieldMapping = [
      { fieldPath: "attributes.*.*", provider: "shopify", target: "meta", remoteKey: "broad" },
      { fieldPath: "attributes.*.title", provider: "shopify", target: "meta", remoteKey: "specific" },
      { fieldPath: "attributes.en.*", provider: "shopify", target: "meta", remoteKey: "tie" },
      { fieldPath: "attributes.en.title", provider: "shopify", target: "native", remoteKey: "exact" },
    ];
    expect(selectCatalogFieldMapping(mapping, "attributes.en.title")).toEqual(expect.objectContaining({ remoteKey: "exact" }));
    expect(selectCatalogFieldMapping(mapping, "attributes.fr.title")).toEqual(expect.objectContaining({ remoteKey: "specific" }));
    expect(selectCatalogFieldMapping(mapping.slice(1, 3), "attributes.en.title")).toEqual(expect.objectContaining({ remoteKey: "specific" }));
  });

  it("skips invalid stored rows and keeps valid rows with warnings", () => {
    const warnings: string[] = [];
    const merged = mergeCatalogFieldMapping("shopify", [
      { fieldPath: "attributes.*.title", provider: "shopify", target: "meta", remoteKey: "custom_title" },
      { fieldPath: "prices.EUR", provider: "shopify", target: "meta", remoteKey: "price" },
    ], undefined, warnings);
    expect(merged).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "attributes.*.title", remoteKey: "custom_title" }),
    ]));
    expect(merged).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "prices.EUR" }),
    ]));
    expect(warnings).toEqual([expect.stringContaining("row 1")]);
  });

  async function createPushEntity(slug: string, status: "active" | "draft" | "archived" | "discontinued" = "active") {
    const result = await built.kernel.services.catalog.create({
      type: "product",
      slug,
      status,
      metadata: {
        collection: "summer",
        color: "red",
        sharedLabel: "shared",
        storeLabel: "store",
      },
      attributes: {
        locale: "en",
        title: "Platform title",
        subtitle: "Platform subtitle",
        description: "Store description",
      },
    }, actor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.value.id;
  }

  async function setPushPlatformOwner(entityId: string, storeId: string, fieldPath: string) {
    const result = await built.kernel.services.catalog.setFieldOwner(
      entityId,
      fieldPath,
      storeId,
      "platform",
      actor,
    );
    expect(result.ok).toBe(true);
  }

  async function mapPushEntity(entityId: string, storeId: string, externalId = entityId, heldFieldPaths: string[] = []) {
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId,
      kind: "entity",
      externalId,
      entityId,
      syncHash: `push-${entityId}`,
      heldFieldPaths,
    });
  }

  it("assembles only concrete platform-owned fields with provider mappings", async () => {
    const storeId = (await connect("shopify", "push-assembly-fields.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-fields");
    await mapPushEntity(entityId, storeId);
    await setPushPlatformOwner(entityId, storeId, "attributes.en.title");
    await setPushPlatformOwner(entityId, storeId, "entity.metadata.collection");

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);

    expect(assembled).toMatchObject({
      ok: true,
      value: { items: [{
        externalId: entityId,
        fields: [
          expect.objectContaining({
            fieldPath: "attributes.en.title",
            intent: "display",
            value: "Platform title",
            locale: "en",
            remoteKey: "title",
          }),
          expect.objectContaining({
            fieldPath: "entity.metadata.collection",
            intent: "tag",
            value: "summer",
            remoteKey: "metafields",
          }),
        ],
      }] },
    });
    if (assembled.ok) expect(assembled.value.items[0]?.fields).toHaveLength(2);
  });

  it("excludes held fields after ownership is flipped to platform", async () => {
    const storeId = (await connect("shopify", "push-assembly-held.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-held");
    await built.db.insert(channelEntityMap).values({
      organizationId: TEST_ORG_ID,
      storeId,
      kind: "entity",
      externalId: "push-assembly-held-remote",
      entityId,
      syncHash: "held",
      heldFieldPaths: ["attributes.en.title"],
    });
    await setPushPlatformOwner(entityId, storeId, "attributes.en.title");

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);

    expect(assembled).toMatchObject({
      ok: true,
      value: {
        items: [{ fields: [] }],
        skipped: [{ entityId, fieldPath: "attributes.en.title", reason: "held" }],
      },
    });
  });

  it("reads approved custom fields and owned media without including shared, store, or unowned paths", async () => {
    const storeId = (await connect("shopify", "push-assembly-approved.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-approved");
    await mapPushEntity(entityId, storeId);
    const definition = await built.kernel.services.catalog.createEntityFieldDefinition({
      entityType: "product",
      name: "material",
      type: "text",
      filterable: true,
    }, actor);
    expect(definition.ok).toBe(true);
    await built.db.insert(sellableCustomFields).values({
      entityId,
      fieldName: "material",
      fieldType: "text",
      source: "merchant",
      status: "approved",
      locale: "en",
      textValue: "linen",
    });
    await built.db.insert(sellableCustomFields).values({
      entityId,
      fieldName: "draftMaterial",
      fieldType: "text",
      source: "enrichment",
      status: "proposed",
      locale: "en",
      textValue: "wool",
    });
    const assetId = crypto.randomUUID();
    await built.db.insert(mediaAssets).values({
      id: assetId,
      organizationId: TEST_ORG_ID,
      storageKey: "push-assembly-image.jpg",
      filename: "push-assembly-image.jpg",
      contentType: "image/jpeg",
      size: 1,
      alt: "Assembly image",
      origin: "merchant",
    });
    await built.db.insert(entityMedia).values({
      entityId,
      mediaAssetId: assetId,
      role: "primary",
      sortOrder: 0,
    });
    await setPushPlatformOwner(entityId, storeId, "customFields.material.en");
    await setPushPlatformOwner(entityId, storeId, "customFields.draftMaterial.en");
    await setPushPlatformOwner(entityId, storeId, "media.primary");
    await setPushPlatformOwner(entityId, storeId, "entity.metadata.collection");
    await built.kernel.services.catalog.setFieldOwner(entityId, "entity.metadata.sharedLabel", storeId, "shared", actor);
    await built.kernel.services.catalog.setFieldOwner(entityId, "entity.metadata.storeLabel", storeId, "store", actor);
    await built.kernel.services.catalog.setFieldOwner(entityId, "attributes.en.description", storeId, "store", actor);

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);

    expect(assembled).toMatchObject({ ok: true, value: { items: [{
      fields: [
        expect.objectContaining({ fieldPath: "customFields.material.en", value: "linen", intent: "filterable" }),
        expect.objectContaining({ fieldPath: "entity.metadata.collection", value: "summer" }),
      ],
      images: [{ url: "http://localhost:3000/test-assets/push-assembly-image.jpg", role: "primary", alt: "Assembly image" }],
    }] } });
    if (assembled.ok) {
      expect(assembled.value.items[0]?.fields).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldPath: "customFields.draftMaterial.en" }),
        expect.objectContaining({ fieldPath: "entity.metadata.sharedLabel" }),
        expect.objectContaining({ fieldPath: "entity.metadata.storeLabel" }),
        expect.objectContaining({ fieldPath: "attributes.en.description" }),
      ]));
    }
  });

  it("surfaces catalog mapping warnings during push assembly", async () => {
    const storeId = (await connect("shopify", "push-assembly-warnings.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-warnings");
    await mapPushEntity(entityId, storeId);
    await setPushPlatformOwner(entityId, storeId, "attributes.en.title");
    await built.db.update(connectedStores).set({
      catalogFieldMapping: [
        { fieldPath: "attributes.*.title", provider: "shopify", target: "meta", remoteKey: "custom_title" },
        { fieldPath: "prices.EUR", provider: "shopify", target: "meta", remoteKey: "price" },
      ],
    }).where(eq(connectedStores.id, storeId));

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);

    expect(assembled).toMatchObject({
      ok: true,
      value: { warnings: [expect.stringContaining("row 1")] },
    });
  });

  it("reports platform-owned fields that have no mapping", async () => {
    const storeId = (await connect("shopify", "push-assembly-no-mapping.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-no-mapping");
    await mapPushEntity(entityId, storeId);
    await setPushPlatformOwner(entityId, storeId, "attributes.en.subtitle");

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);

    expect(assembled).toMatchObject({
      ok: true,
      value: {
        items: [{ fields: [] }],
        skipped: [{ entityId, fieldPath: "attributes.en.subtitle", reason: "no_mapping" }],
      },
    });
  });

  it("refuses assembly when catalog writes are disabled or the store is disconnected", async () => {
    const storeId = (await connect("shopify", "push-assembly-gate.myshopify.com")).id;
    const entityId = await createPushEntity("push-assembly-gate");

    const disabled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.code).toBe("CATALOG_WRITE_DISABLED");

    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    await service.disconnectStore(TEST_ORG_ID, storeId);
    const disconnected = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);
    expect(disconnected.ok).toBe(false);
    if (!disconnected.ok) expect(disconnected.code).toBe("NOT_FOUND");
  });

  it("skips non-active entities instead of assembling them", async () => {
    const storeId = (await connect("shopify", "push-assembly-draft.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-draft", "draft");
    await mapPushEntity(entityId, storeId);

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);

    expect(assembled).toMatchObject({
      ok: true,
      value: {
        items: [],
        skipped: [{ entityId, fieldPath: "entity.status", reason: "entity_not_active" }],
      },
    });
  });

  it("skips active entities without a channel mapping", async () => {
    const storeId = (await connect("shopify", "push-assembly-unmapped.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-unmapped");

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);

    expect(assembled).toMatchObject({
      ok: true,
      value: {
        items: [],
        skipped: [{ entityId, fieldPath: "entity", reason: "unmapped_entity" }],
      },
    });
  });

  it("refuses assembly through a store from another organization", async () => {
    const storeId = (await connect("shopify", "push-assembly-cross-org.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-cross-org");

    const assembled = await service.buildCatalogPushItems(OTHER_ORG_ID, storeId, [entityId]);

    expect(assembled).toEqual({ ok: false, error: "Connected store not found.", code: "NOT_FOUND" });
  });

  it("does not expand an ancestor mapping into child fields", async () => {
    const storeId = (await connect("shopify", "push-assembly-ancestor.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-ancestor");
    await mapPushEntity(entityId, storeId);
    await service.updateCatalogFieldMapping(TEST_ORG_ID, storeId, [{
      fieldPath: "entity.metadata",
      provider: "shopify",
      target: "meta",
      remoteKey: "ancestor",
    }, {
      fieldPath: "entity.metadata.color",
      provider: "shopify",
      target: "meta",
      remoteKey: "concrete",
    }]);
    await setPushPlatformOwner(entityId, storeId, "entity.metadata.color");

    const assembled = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);

    expect(assembled).toMatchObject({
      ok: true,
      value: {
        items: [{
          fields: [{ fieldPath: "entity.metadata.color", remoteKey: "concrete" }],
        }],
      },
    });
  });

  it("records a push revision only when explicitly requested", async () => {
    const storeId = (await connect("shopify", "push-assembly-revision.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const entityId = await createPushEntity("push-assembly-revision");
    await mapPushEntity(entityId, storeId);

    const preview = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId]);
    expect(preview.ok).toBe(true);
    const before = await built.db.select({ reason: sellableEntityRevisions.reason }).from(sellableEntityRevisions).where(
      eq(sellableEntityRevisions.entityId, entityId),
    );
    expect(before.some((revision) => revision.reason === "push")).toBe(false);

    const requested = await service.buildCatalogPushItems(TEST_ORG_ID, storeId, [entityId], { recordRevision: true });
    expect(requested.ok).toBe(true);
    const after = await built.db.select({ reason: sellableEntityRevisions.reason }).from(sellableEntityRevisions).where(
      eq(sellableEntityRevisions.entityId, entityId),
    );
    expect(after.some((revision) => revision.reason === "push")).toBe(true);
  });

  it("does not persist partial push revisions when a later entity fails", async () => {
    const storeId = (await connect("shopify", "push-assembly-revision-rollback.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const firstEntityId = await createPushEntity("push-assembly-revision-rollback-first");
    await mapPushEntity(firstEntityId, storeId);
    const missingEntityId = crypto.randomUUID();

    const assembled = await service.buildCatalogPushItems(
      TEST_ORG_ID,
      storeId,
      [firstEntityId, missingEntityId],
      { recordRevision: true },
    );

    expect(assembled).toEqual({ ok: false, error: "Catalog entity not found.", code: "NOT_FOUND" });
    const revisions = await built.db.select({ reason: sellableEntityRevisions.reason }).from(sellableEntityRevisions).where(
      eq(sellableEntityRevisions.entityId, firstEntityId),
    );
    expect(revisions.some((revision) => revision.reason === "push")).toBe(false);
  });

  it("records outbound suppression per confirmed item and clears failed items", async () => {
    const storeId = (await connect("shopify", "push-outbound-per-item.myshopify.com")).id;
    await service.updateCatalogWriteEnabled(TEST_ORG_ID, storeId, true);
    const firstEntityId = await createPushEntity("push-outbound-per-item-first");
    const failedEntityId = await createPushEntity("push-outbound-per-item-failed");
    await mapPushEntity(firstEntityId, storeId);
    await mapPushEntity(failedEntityId, storeId);
    await setPushPlatformOwner(firstEntityId, storeId, "attributes.en.title");
    await setPushPlatformOwner(failedEntityId, storeId, "attributes.en.title");
    const failingConnector = {
      ...mockChannelConnector({ pushCatalogFailures: { [failedEntityId]: { code: "REMOTE_VALIDATION", message: "Rejected." } } }),
      providerId: "shopify",
    };
    const pushService = new ChannelConnectorService(
      built.db,
      built.kernel.services,
      { connectors: [failingConnector] },
      built.kernel.database.transaction as PluginTxFn,
    );

    const result = await pushService.pushCatalogToStore(TEST_ORG_ID, storeId, [firstEntityId, failedEntityId]);

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcomes: [
          { externalId: firstEntityId, ok: true },
          { externalId: failedEntityId, ok: false },
        ],
      },
    });
    const mappings = await built.db.select({
      externalId: channelEntityMap.externalId,
      outboundHash: channelEntityMap.outboundHash,
      outboundPushedAt: channelEntityMap.outboundPushedAt,
      outboundFieldPaths: channelEntityMap.outboundFieldPaths,
      syncHash: channelEntityMap.syncHash,
    }).from(channelEntityMap).where(eq(channelEntityMap.storeId, storeId));
    expect(mappings.find((mapping) => mapping.externalId === firstEntityId)).toMatchObject({
      outboundHash: expect.any(String),
      outboundPushedAt: expect.any(Date),
      outboundFieldPaths: ["attributes.en.title"],
    });
    expect(mappings.find((mapping) => mapping.externalId === failedEntityId)).toMatchObject({
      outboundHash: null,
      outboundPushedAt: null,
      outboundFieldPaths: [],
      syncHash: "",
    });
  });

  describe("mock connector catalog push", () => {
    it("returns an ok outcome for every item and records the batch", async () => {
      const pushed: ChannelPushCatalogItem[][] = [];
      const connector = mockChannelConnector({ onPushCatalog: (batch) => pushed.push(batch) });

      const result = await connector.pushCatalog!(pushStore, pushItems);

      expect(result).toEqual({
        ok: true,
        value: {
          outcomes: [
            { externalId: "push-product-1", ok: true },
            { externalId: "push-product-2", ok: true },
          ],
        },
      });
      expect(pushed).toEqual([pushItems]);
    });

    it("keeps one failed item inside a successful batch", async () => {
      const failure: ChannelConnectorError = {
        code: "REMOTE_VALIDATION",
        message: "The remote catalog rejected this item.",
        retriable: false,
      };
      const connector = mockChannelConnector({
        pushCatalogFailures: { "push-product-2": failure },
      });

      const result = await connector.pushCatalog!(pushStore, pushItems);

      expect(result).toEqual({
        ok: true,
        value: {
          outcomes: [
            { externalId: "push-product-1", ok: true },
            { externalId: "push-product-2", ok: false, error: failure },
          ],
        },
      });
    });

    it("returns a transport error when the whole batch cannot be sent", async () => {
      const failure: ChannelConnectorError = {
        code: "REMOTE_UNAVAILABLE",
        message: "The remote catalog is unavailable.",
        retriable: true,
      };
      const connector = mockChannelConnector({ pushCatalogTransportError: failure });

      await expect(connector.pushCatalog!(pushStore, pushItems)).resolves.toEqual({
        ok: false,
        error: failure,
      });
    });

    it("returns the same outcomes without recording a dry-run batch", async () => {
      const pushed: ChannelPushCatalogItem[][] = [];
      const connector = mockChannelConnector({ onPushCatalog: (batch) => pushed.push(batch) });

      const result = await connector.pushCatalog!(pushStore, pushItems, { dryRun: true });

      expect(result).toEqual({
        ok: true,
        value: {
          outcomes: [
            { externalId: "push-product-1", ok: true },
            { externalId: "push-product-2", ok: true },
          ],
        },
      });
      expect(pushed).toEqual([]);
    });
  });
});
