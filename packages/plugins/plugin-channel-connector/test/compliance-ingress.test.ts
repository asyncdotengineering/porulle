import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Ok } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core/testing";
import { eq } from "@porulle/core/drizzle";
import { channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { channelOrderExports } from "../src/schema.js";

// RED GATE — target design for task c3e5dcf5.
//
// Shopify's mandatory GDPR compliance webhooks (customers/data_request,
// customers/redact, shop/redact) are delivered to a SINGLE app-level URL,
// signed with the app CLIENT SECRET (not a per-store webhookSecret), and
// identify the target store by `shop_domain` in the payload.
//
// This test asserts that correct ingress:
//   POST /api/channels/compliance/{provider}  (unauthenticated, single URL)
//   - HMAC verified against the app client secret -> 401 on mismatch
//   - store resolved by shop_domain from the payload
//   - redaction runs through the existing (correct) service methods
//
// It fails RED today: the endpoint does not exist (404), and the connector
// has no app-secret verification path. It goes GREEN when the app-level
// compliance ingress is built.

const APP_SECRET = "shopify-app-client-secret";

function complianceIngressConnector() {
  const base = mockChannelConnector();
  return {
    ...base,
    providerId: "shopify",
    // Intended contract: verify an APP-level webhook against the app client secret,
    // returning the topic + shop domain from the (verified) payload.
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

describe("Shopify app-level compliance ingress (target design)", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let storeId: string;
  const orgId = testAdminActor.organizationId!;

  beforeAll(async () => {
    const connector = complianceIngressConnector();
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [connector] }));
    const connected = await built.app.request("http://localhost/api/channels/stores", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({
        provider: "shopify",
        credentials: { accessToken: "oauth-token" },
        storeDomain: "acme.myshopify.com",
        webhookSecret: "store-secret",
      }),
    });
    expect(connected.status).toBe(201);
    storeId = (await connected.json()).data.id as string;
    await built.db.insert(channelOrderExports).values({
      organizationId: orgId,
      storeId,
      orderId: crypto.randomUUID(),
      customerData: {
        name: "Priya Shopper",
        email: "priya@example.test",
        shippingAddress: { address1: "1 Main Street", city: "Colombo", country: "LK" },
      },
    });
  }, 30_000);

  function appWebhook(topic: string, data: Record<string, unknown>, secret = APP_SECRET) {
    const body = JSON.stringify(data);
    const signature = createHmac("sha256", secret).update(body).digest("base64");
    return built.app.request("http://localhost/api/channels/compliance/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": signature,
        "x-shopify-topic": topic,
      },
      body,
    });
  }

  it("redacts customer PII resolved by shop_domain when the app-secret HMAC is valid", async () => {
    const res = await appWebhook("customers/redact", {
      shop_domain: "acme.myshopify.com",
      customer: { email: "priya@example.test" },
    });
    expect(res.status).toBe(200);
    const rows = await built.db
      .select()
      .from(channelOrderExports)
      .where(eq(channelOrderExports.storeId, storeId));
    expect(rows[0]?.customerData).toBeNull();
  });

  it("rejects an invalid app-secret HMAC with 401 (Shopify requires 401)", async () => {
    const res = await appWebhook("shop/redact", { shop_domain: "acme.myshopify.com" }, "wrong-secret");
    expect(res.status).toBe(401);
  });
});
