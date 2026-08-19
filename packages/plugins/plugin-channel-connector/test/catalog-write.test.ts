import { beforeAll, describe, expect, it } from "vitest";
import {
  type Actor,
  type PluginTxFn,
} from "@porulle/core";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { eq } from "@porulle/core/drizzle";
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
import { connectedStores } from "../src/schema.js";

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
});
