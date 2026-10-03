/**
 * A provider that signs per APP (Shopify) delivers every topic for every shop to ONE address. These
 * rows drive that address the way Shopify does — raw body, base64 HMAC with the app secret, the shop
 * and the delivery id in headers — and assert what the store and catalogue look like after the
 * queued job applied it.
 *
 * What could pass without proving the behaviour, written first:
 *  - the route answers 200 and nothing is applied → every row runs the jobs and asserts the DB;
 *  - a duplicate delivery is applied twice → a counted side effect, not the status code;
 *  - a product webhook converges the stale PAYLOAD instead of re-reading → the payload carries a
 *    different title than the provider's current answer, and the current answer must win;
 *  - a forged delivery is queued and only fails later → 401 AND no job row.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Ok, runPendingJobs } from "@porulle/core";
import type { ChannelCatalogItem, ChannelStore } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core/testing";
import { and, eq } from "@porulle/core/drizzle";
import { commerceJobs, sellableAttributes, sellableEntities } from "@porulle/core/schema";
import { channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { channelEntityMap, channelOrderExports, connectedStores } from "../src/schema.js";

const APP_SECRET = "shopify-app-client-secret";
const SHOP = "acme.myshopify.com";
const orgId = testAdminActor.organizationId!;

function product(externalId: string, title: string): ChannelCatalogItem {
  return {
    externalId,
    slug: `product-${externalId}`,
    title,
    status: "active",
    variants: [{ externalId: `${externalId}-v1`, sku: `SKU-${externalId}`, prices: [{ currency: "LKR", amount: 150000 }] }],
  };
}

/** The provider's CURRENT catalogue; a webhook is a notification that something in it changed. */
const remote = new Map<string, ChannelCatalogItem>();

function appConnector() {
  const base = mockChannelConnector({ catalog: [] });
  return {
    ...base,
    providerId: "shopify",
    async fetchCatalogItems(_store: ChannelStore, ids: string[]) {
      return Ok(ids.flatMap((id) => {
        const item = remote.get(id);
        return item ? [item] : [];
      }));
    },
    async verifyAppWebhook(request: Request) {
      const body = await request.text();
      const expected = createHmac("sha256", APP_SECRET).update(body).digest("base64");
      if ((request.headers.get("x-shopify-hmac-sha256") ?? "") !== expected) {
        return { ok: false as const, error: { code: "INVALID_APP_WEBHOOK_SIGNATURE", message: "Invalid app HMAC." } };
      }
      return Ok({
        id: request.headers.get("x-shopify-webhook-id") ?? "",
        topic: request.headers.get("x-shopify-topic") ?? "",
        shopDomain: request.headers.get("x-shopify-shop-domain") ?? "",
        data: JSON.parse(body) as unknown,
      });
    },
  };
}

describe("app-level webhooks (Shopify's single address)", { timeout: 120_000 }, () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let storeId: string;
  let changed: string[][];

  async function runJobs() {
    return runPendingJobs({
      db: built.kernel.database.db as Parameters<typeof runPendingJobs>[0]["db"],
      tasks: new Map((built.kernel.config.jobs?.tasks ?? []).map((task) => [task.slug, task])),
      logger: built.kernel.logger,
      services: built.kernel.services,
      limit: 100,
    });
  }

  function deliver(topic: string, data: Record<string, unknown>, options: { id?: string; secret?: string; shop?: string } = {}) {
    const body = JSON.stringify(data);
    return built.app.request("http://localhost/api/channels/app-webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": createHmac("sha256", options.secret ?? APP_SECRET).update(body).digest("base64"),
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": options.shop ?? SHOP,
        "x-shopify-webhook-id": options.id ?? crypto.randomUUID(),
      },
      body,
    });
  }

  async function entityFor(externalId: string) {
    const [mapping] = await built.db.select().from(channelEntityMap).where(and(eq(channelEntityMap.storeId, storeId), eq(channelEntityMap.kind, "entity"), eq(channelEntityMap.externalId, externalId)));
    if (!mapping) return undefined;
    const [entity] = await built.db.select().from(sellableEntities).where(eq(sellableEntities.id, mapping.entityId));
    return entity;
  }

  beforeEach(async () => {
    remote.clear();
    changed = [];
    built = await createPluginTestApp(channelConnectorPlugin({
      connectors: [appConnector()],
      onStoreCatalogChanged: async ({ entityIds }) => { changed.push(entityIds); },
    }));
    const connected = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "shopify", credentials: { accessToken: "token" }, storeDomain: SHOP }),
    });
    expect(connected.status).toBe(201);
    storeId = (await connected.json()).data.id as string;
  }, 120_000);

  it("creates a product the store has never sent, from the provider's current answer, and tells the host", async () => {
    remote.set("101", product("101", "Linen Shirt"));
    const response = await deliver("products/create", { id: 101, title: "stale payload title" });
    expect(response.status).toBe(200);
    await runJobs();
    const entity = await entityFor("101");
    expect(entity).toBeDefined();
    expect(changed).toEqual([[entity!.id]]);
  });

  it("applies an update from a fresh read, never from the delivery's payload", async () => {
    remote.set("102", product("102", "Original"));
    await deliver("products/create", { id: 102 });
    await runJobs();
    remote.set("102", product("102", "Renamed upstream"));
    await deliver("products/update", { id: 102, title: "older payload" });
    await runJobs();
    const entity = await entityFor("102");
    expect(entity).toBeDefined();
    const titles = await built.db.select({ title: sellableAttributes.title }).from(sellableAttributes).where(eq(sellableAttributes.entityId, entity?.id ?? ""));
    expect(titles.map((row) => row.title)).toEqual(["Renamed upstream"]);
    expect(changed).toHaveLength(2);
  });

  it("archives a product the provider no longer has, whether deleted or gone by the time it is read", async () => {
    remote.set("103", product("103", "Short lived"));
    await deliver("products/create", { id: 103 });
    await runJobs();
    remote.delete("103");
    await deliver("products/update", { id: 103 });
    await runJobs();
    expect((await entityFor("103"))?.status).toBe("archived");
  });

  it("applies one delivery once, however many times it arrives", async () => {
    remote.set("104", product("104", "Once"));
    const first = await deliver("products/create", { id: 104 }, { id: "delivery-104" });
    const again = await deliver("products/create", { id: 104 }, { id: "delivery-104" });
    expect((await again.json()).data.duplicate).toBe(true);
    expect(first.status).toBe(200);
    await runJobs();
    expect(changed).toHaveLength(1);
  });

  it("refuses a forged delivery with 401 and queues nothing", async () => {
    const before = await built.db.select().from(commerceJobs);
    const response = await deliver("shop/redact", {}, { secret: "wrong-secret" });
    expect(response.status).toBe(401);
    expect(await built.db.select().from(commerceJobs)).toHaveLength(before.length);
  });

  it("redacts channel-held customer data on every store row the shop domain names", async () => {
    // A second row for the same shop: what an organization holds if it connected the shop before
    // connect refreshed one row instead of adding another. Compliance must reach both.
    const [legacy] = await built.db.insert(connectedStores).values({ organizationId: orgId, provider: "shopify", credentials: {}, storeDomain: SHOP }).returning();
    const storeIds = [storeId, legacy?.id ?? ""];
    for (const id of storeIds) {
      await built.db.insert(channelOrderExports).values({
        organizationId: orgId,
        storeId: id,
        orderId: crypto.randomUUID(),
        customerData: { name: "Priya", email: "priya@example.test", shippingAddress: { firstName: "Priya", lastName: "S", line1: "1 Main Street", city: "Colombo", countryCode: "LK" } },
      });
    }
    await deliver("customers/redact", { shop_domain: SHOP, customer: { email: "priya@example.test" } });
    await runJobs();
    for (const id of storeIds) {
      const rows = await built.db.select().from(channelOrderExports).where(eq(channelOrderExports.storeId, id));
      expect(rows[0]?.customerData, `store ${id}`).toBeNull();
    }
  });

  it("disconnects the store when the merchant uninstalls the app", async () => {
    await deliver("app/uninstalled", { id: 1, domain: SHOP });
    await runJobs();
    const [store] = await built.db.select().from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(store).toMatchObject({ status: "disconnected", credentials: {} });
  });
});

describe("per-store webhook subscriptions", () => {
  it("are registered at an absolute address on this deployment's public origin", async () => {
    const callbacks: string[] = [];
    const connector = { ...mockChannelConnector({ catalog: [] }), providerId: "woocommerce", async registerWebhooks(_store: ChannelStore, topics: string[], url: string) { callbacks.push(url); return Ok({ registered: topics.length }); } };
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector], publicUrl: "https://merchant.example" }));
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "woocommerce", credentials: { consumerKey: "k" }, storeDomain: "shop.example" }),
    });
    expect(response.status).toBe(201);
    const id = (await response.json()).data.id as string;
    expect(callbacks).toEqual([`https://merchant.example/api/channels/webhooks/${id}`]);
  }, 30_000);

  it("refuse to connect without a public origin to register", async () => {
    const connector = { ...mockChannelConnector({ catalog: [] }), providerId: "woocommerce", async registerWebhooks() { return Ok({ registered: 0 }); } };
    const built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const response = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "woocommerce", credentials: { consumerKey: "k" }, storeDomain: "shop.example" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await built.db.select().from(connectedStores)).toHaveLength(0);
  }, 30_000);
});
