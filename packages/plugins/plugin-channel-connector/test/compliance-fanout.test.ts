import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Ok } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core/testing";
import { eq } from "@porulle/core/drizzle";
import { channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { channelOrderExports } from "../src/schema.js";

// RED GATE — task d51ae76d.
// A single shop_domain can map to more than one connected_stores row (same shop
// reconnected, or connected under two orgs). A GDPR customers/redact must erase
// PII on ALL matching stores, not just the first getStoreByDomain result.

const APP_SECRET = "shopify-app-client-secret";
const SHARED_DOMAIN = "shared.myshopify.com";

function complianceConnector() {
  const base = mockChannelConnector();
  return {
    ...base,
    providerId: "shopify",
    async verifyAppWebhook(request: Request) {
      const body = await request.text();
      const expected = createHmac("sha256", APP_SECRET).update(body).digest("base64");
      if ((request.headers.get("x-shopify-hmac-sha256") ?? "") !== expected) {
        return { ok: false as const, error: { code: "INVALID_APP_HMAC", message: "Invalid app HMAC." } };
      }
      const data = JSON.parse(body) as { shop_domain?: string };
      return Ok({ topic: request.headers.get("x-shopify-topic") ?? "", shopDomain: data.shop_domain ?? "", data });
    },
  };
}

describe("Shopify compliance redact fan-out across stores sharing a domain", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  const storeIds: string[] = [];

  beforeAll(async () => {
    built = await createPluginTestApp(channelConnectorPlugin({ connectors: [complianceConnector()] }));
    // Two stores on the SAME shop_domain, each holding the customer's PII.
    for (let i = 0; i < 2; i++) {
      const connected = await built.app.request("http://localhost/api/channels/stores", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({
          provider: "shopify",
          credentials: { accessToken: `token-${i}` },
          storeDomain: SHARED_DOMAIN,
          webhookSecret: `secret-${i}`,
        }),
      });
      const id = (await connected.json()).data.id as string;
      storeIds.push(id);
      await built.db.insert(channelOrderExports).values({
        organizationId: testAdminActor.organizationId!,
        storeId: id,
        orderId: crypto.randomUUID(),
        customerData: { name: "Priya", email: "priya@example.test", shippingAddress: {} },
      });
    }
  }, 30_000);

  it("nulls customerData on every store matching the shop_domain", async () => {
    const body = JSON.stringify({ shop_domain: SHARED_DOMAIN, customer: { email: "priya@example.test" } });
    const signature = createHmac("sha256", APP_SECRET).update(body).digest("base64");
    const res = await built.app.request("http://localhost/api/channels/compliance/shopify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-hmac-sha256": signature, "x-shopify-topic": "customers/redact" },
      body,
    });
    expect(res.status).toBe(200);
    for (const id of storeIds) {
      const rows = await built.db.select().from(channelOrderExports).where(eq(channelOrderExports.storeId, id));
      expect(rows[0]?.customerData, `store ${id} should be redacted`).toBeNull();
    }
  });
});
