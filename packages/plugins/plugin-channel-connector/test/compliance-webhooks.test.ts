import { beforeAll, describe, expect, it } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Ok } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core/testing";
import { and, eq } from "@porulle/core/drizzle";
import { channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { channelOrderExports, connectedStores } from "../src/schema.js";

const WEBHOOK_SECRET = "shopify-compliance-secret";
const APP_SECRET = "shopify-app-client-secret";

function complianceConnector() {
  const base = mockChannelConnector();
  const registeredTopics: string[] = [];
  return {
    ...base,
    providerId: "shopify",
    registeredTopics,
    async registerWebhooks(_store: { webhookSecret: string | null }, topics: string[]) {
      registeredTopics.push(...topics);
      return Ok({ registered: topics.length });
    },
    async verifyWebhook(store: Parameters<typeof base.verifyWebhook>[0], request: Request) {
      const body = await request.text();
      const expected = createHmac("sha256", store.webhookSecret ?? "").update(body).digest();
      const signature = Buffer.from(request.headers.get("x-shopify-hmac-sha256") ?? "", "base64");
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return { ok: false as const, error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Invalid signature." } };
      const id = request.headers.get("x-shopify-event-id");
      const type = request.headers.get("x-shopify-topic");
      if (!id || !type) return { ok: false as const, error: { code: "INVALID_WEBHOOK", message: "Webhook headers are incomplete." } };
      return Ok({ id, type, data: JSON.parse(body) as unknown });
    },
    async verifyAppWebhook(request: Request) {
      const body = await request.text();
      const expected = createHmac("sha256", APP_SECRET).update(body).digest("base64");
      const signature = request.headers.get("x-shopify-hmac-sha256") ?? "";
      if (signature !== expected) {
        return { ok: false as const, error: { code: "INVALID_APP_HMAC", message: "Invalid app HMAC." } };
      }
      const topic = request.headers.get("x-shopify-topic") ?? "";
      const data = JSON.parse(body) as { shop_domain?: string };
      return Ok({ topic, shopDomain: data.shop_domain ?? "", data });
    },
  };
}

describe("Shopify compliance webhooks", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let connector: ReturnType<typeof complianceConnector>;
  let storeId: string;

  beforeAll(async () => {
    connector = complianceConnector();
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const connected = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        provider: "shopify",
        credentials: { accessToken: "oauth-token" },
        storeDomain: "acme.myshopify.com",
        webhookSecret: WEBHOOK_SECRET,
      }),
    });
    expect(connected.status).toBe(201);
    storeId = (await connected.json()).data.id as string;
    await built.db.insert(channelOrderExports).values({
      organizationId: testAdminActor.organizationId!,
      storeId,
      orderId: crypto.randomUUID(),
      customerData: {
        name: "Priya Shopper",
        email: "priya@example.test",
        shippingAddress: { address1: "1 Main Street", city: "Colombo", country: "LK" },
      },
    });
  }, 30_000);

  async function webhook(type: string, data: Record<string, unknown>, id: string) {
    const body = JSON.stringify(data);
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("base64");
    return built.app.request(`http://localhost/api/channels/webhooks/${storeId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": signature,
        "x-shopify-event-id": id,
        "x-shopify-topic": type,
      },
      body,
    });
  }

  async function appWebhook(type: string, data: Record<string, unknown>, secret = APP_SECRET) {
    const body = JSON.stringify(data);
    const signature = createHmac("sha256", secret).update(body).digest("base64");
    return built.app.request("http://localhost/api/channels/compliance/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": signature,
        "x-shopify-topic": type,
      },
      body,
    });
  }

  it("registers sync topics + app/uninstalled per-store (GDPR topics are app-level, not per-store)", () => {
    // The three mandatory GDPR topics (customers/data_request, customers/redact, shop/redact)
    // are configured at the app level in shopify.app.toml and delivered to a single app URL —
    // they are NOT registerable per-store via the Admin API, so they must not appear here.
    expect(connector.registeredTopics).toEqual([
      "products/update",
      "products/delete",
      "inventory_levels/update",
      "orders/fulfilled",
      "orders/cancelled",
      "refunds/create",
      "app/uninstalled",
    ]);
  });

  it("returns channel-held customer data only for a verified data request", async () => {
    const response = await appWebhook("customers/data_request", { shop_domain: "acme.myshopify.com", customer: { id: "shopify-customer-1", email: "priya@example.test" } });
    expect(response.status).toBe(200);
    expect((await response.json()).data.data.exports[0].customerData).toEqual({
      name: "Priya Shopper",
      email: "priya@example.test",
      shippingAddress: { address1: "1 Main Street", city: "Colombo", country: "LK" },
    });
  });

  it("redacts customer slice PII after app-secret HMAC verification", async () => {
    const response = await appWebhook("customers/redact", { shop_domain: "acme.myshopify.com", customer: { email: "priya@example.test" } });
    expect(response.status).toBe(200);
    expect((await response.json()).data.redacted).toBe(1);
    const rows = await built.db.select().from(channelOrderExports).where(eq(channelOrderExports.storeId, storeId));
    expect(rows[0]?.customerData).toBeNull();
  });

  it("redacts all shop slices and disconnects the store via app-level endpoint", async () => {
    const second = await built.db.insert(channelOrderExports).values({
      organizationId: testAdminActor.organizationId!,
      storeId,
      orderId: crypto.randomUUID(),
      customerData: { name: "Second", email: "second@example.test", shippingAddress: { city: "Galle" } },
    }).returning({ id: channelOrderExports.id });
    const response = await appWebhook("shop/redact", { shop_domain: "acme.myshopify.com" });
    expect(response.status).toBe(200);
    expect((await response.json()).data.redacted).toBe(1);
    const rows = await built.db.select().from(channelOrderExports).where(and(
      eq(channelOrderExports.storeId, storeId),
      eq(channelOrderExports.id, second[0]!.id),
    ));
    expect(rows[0]?.customerData).toBeNull();
    const store = await built.db.select().from(connectedStores).where(eq(connectedStores.id, storeId));
    expect(store[0]).toMatchObject({ status: "disconnected", credentials: {}, webhookSecret: null, storeDomain: "[REDACTED]" });
  });

  it("disconnects an uninstalled store through the per-store webhook path", async () => {
    // app/uninstalled is registered per-store via Admin API and also arrives app-secret-signed
    // at the app-level compliance URL. We keep the per-store route for backwards compatibility
    // with stores already registered there; both paths call disconnectStoreSystem.
    const connected = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "shopify", credentials: { accessToken: "second-token" }, storeDomain: "second.myshopify.com", webhookSecret: "second-secret" }),
    });
    const secondStoreId = (await connected.json()).data.id as string;
    const body = JSON.stringify({ shop_domain: "second.myshopify.com" });
    const signature = createHmac("sha256", "second-secret").update(body).digest("base64");
    const response = await built.app.request(`http://localhost/api/channels/webhooks/${secondStoreId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-hmac-sha256": signature, "x-shopify-event-id": "compliance-uninstall-1", "x-shopify-topic": "app/uninstalled" },
      body,
    });
    expect(response.status).toBe(200);
    const store = await built.db.select().from(connectedStores).where(eq(connectedStores.id, secondStoreId));
    expect(store[0]).toMatchObject({ status: "disconnected", credentials: {}, webhookSecret: null });
  });

  it("rejects a forged per-store webhook before dispatch", async () => {
    const connected = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ provider: "shopify", credentials: { accessToken: "forged-test-token" }, storeDomain: "forged.myshopify.com", webhookSecret: "forged-secret" }),
    });
    const forgedStoreId = (await connected.json()).data.id as string;
    const body = JSON.stringify({ customer: { email: "priya@example.test" } });
    const response = await built.app.request(`http://localhost/api/channels/webhooks/${forgedStoreId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-hmac-sha256": "invalid", "x-shopify-event-id": "compliance-forged-1", "x-shopify-topic": "customers/redact" },
      body,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a forged app-level compliance webhook with 401", async () => {
    const response = await appWebhook("customers/redact", { shop_domain: "acme.myshopify.com", customer: { email: "priya@example.test" } }, "wrong-secret");
    expect(response.status).toBe(401);
  });
});
