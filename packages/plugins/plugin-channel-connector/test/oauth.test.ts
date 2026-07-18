import { beforeAll, describe, expect, it } from "vitest";
import { Ok } from "@porulle/core";
import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core/testing";
import { sql, eq } from "@porulle/core/drizzle";
import { connectedStores } from "../src/schema.js";
import { channelConnectorPlugin, mockChannelConnector } from "../src/index.js";
import { signState, verifyState } from "../src/oauth-state.js";

const STATE_SECRET = "oauth-state-secret";
const REDIRECT = "https://dashboard.example/stores";

function shopifyCallbackUrl(state: string): string {
  const url = new URL("http://localhost/api/channels/oauth/shopify/callback");
  url.searchParams.set("code", "oauth-code");
  url.searchParams.set("shop", "acme.myshopify.com");
  url.searchParams.set("state", state);
  return url.toString();
}

function oauthConnector(provider: "shopify" | "woocommerce") {
  const base = mockChannelConnector();
  return {
    ...base,
    providerId: provider,
    buildAuthUrl(params: { storeDomain: string; state: string; redirectUri: string; callbackUri: string; scopes: string[] }) {
      if (provider === "shopify") {
        const url = new URL(`https://${params.storeDomain}/admin/oauth/authorize`);
        url.searchParams.set("state", params.state);
        return Ok(url.toString());
      }
      const url = new URL(`${params.storeDomain}/wc-auth/v1/authorize`);
      const returnUrl = new URL(params.callbackUri);
      returnUrl.searchParams.set("state", params.state);
      returnUrl.searchParams.set("return", "1");
      const callbackUrl = new URL(params.callbackUri);
      callbackUrl.searchParams.set("state", params.state);
      url.searchParams.set("return_url", returnUrl.toString());
      url.searchParams.set("callback_url", callbackUrl.toString());
      return Ok(url.toString());
    },
    async completeAuth(request: Request, ctx: { storeDomain: string }) {
      return Ok({
        credentials: provider === "shopify" ? { accessToken: "oauth-token" } : { consumerKey: "ck_oauth", consumerSecret: "cs_oauth" },
        storeDomain: ctx.storeDomain,
      });
    },
  };
}

describe("channel connector OAuth routes", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let withoutOAuth: Awaited<ReturnType<typeof createPluginTestApp>>;

  beforeAll(async () => {
    const shopify = oauthConnector("shopify");
    const woo = oauthConnector("woocommerce");
    const pluginOptions = {
      connectors: [shopify, woo],
      oauth: { stateSecret: STATE_SECRET, postConnectRedirect: REDIRECT },
    };
    built = await createPluginTestApp(channelConnectorPlugin(pluginOptions));
    withoutOAuth = await createPluginTestApp(channelConnectorPlugin({ connectors: [shopify] }));
  }, 30_000);

  it("builds Shopify start URLs and completes the callback through connectStore", async () => {
    const start = await built.app.request("http://localhost/api/channels/oauth/shopify/start?shop=acme.myshopify.com", {
      headers: jsonHeaders(testAdminActor),
    });
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.origin).toBe("https://acme.myshopify.com");
    expect(location.pathname).toBe("/admin/oauth/authorize");
    expect(location.searchParams.get("state")).toBeTruthy();
    const state = location.searchParams.get("state")!;

    const callback = await built.app.request(shopifyCallbackUrl(state));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(REDIRECT);
    const stores = await built.db.select().from(connectedStores).where(eq(connectedStores.storeDomain, "acme.myshopify.com"));
    expect(stores).toHaveLength(1);
    expect(stores[0]?.credentials).toEqual({ accessToken: "oauth-token" });
    const jobsRaw = await built.db.execute(sql`
      SELECT organization_id FROM commerce_jobs WHERE task_slug = 'channel/import-catalog'
    `);
    const jobs = Array.isArray(jobsRaw) ? jobsRaw : ((jobsRaw as { rows?: unknown[] }).rows ?? []);
    expect(jobs).toHaveLength(1);
  });

  it("rejects OAuth state replay and expiry", async () => {
    const start = await built.app.request("http://localhost/api/channels/oauth/shopify/start?shop=second.myshopify.com", {
      headers: jsonHeaders(testAdminActor),
    });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    expect((await built.app.request(shopifyCallbackUrl(state))).status).toBe(302);
    expect((await built.app.request(shopifyCallbackUrl(state))).status).toBe(403);

    const expired = signState({
      provider: "shopify",
      orgId: testAdminActor.organizationId!,
      shopDomain: "expired.myshopify.com",
      exp: Math.floor(Date.now() / 1000) - 1,
      jti: crypto.randomUUID(),
    }, STATE_SECRET);
    expect((await built.app.request(shopifyCallbackUrl(expired))).status).toBe(403);
  });

  it("builds Woo URLs with dual state-bearing callbacks and completes the server POST", async () => {
    const start = await built.app.request("http://localhost/api/channels/oauth/woocommerce/start?store=https://woo.example", {
      headers: jsonHeaders(testAdminActor),
    });
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    const returnUrl = new URL(location.searchParams.get("return_url")!);
    const callbackUrl = new URL(location.searchParams.get("callback_url")!);
    expect(returnUrl.searchParams.get("state")).toBe(callbackUrl.searchParams.get("state"));
    expect(returnUrl.searchParams.get("return")).toBe("1");
    expect(callbackUrl.searchParams.get("state")).toBeTruthy();

    const callback = await built.app.request(callbackUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumer_key: "ck_oauth", consumer_secret: "cs_oauth" }),
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(REDIRECT);
    const landing = await built.app.request(returnUrl.toString());
    expect(landing.status).toBe(302);
    expect(landing.headers.get("location")).toBe(REDIRECT);
    const stores = await built.db.select().from(connectedStores).where(eq(connectedStores.storeDomain, "https://woo.example"));
    expect(stores[0]?.credentials).toEqual({ consumerKey: "ck_oauth", consumerSecret: "cs_oauth" });
  });

  it("returns a clear 501 when OAuth is not configured", async () => {
    const response = await withoutOAuth.app.request("http://localhost/api/channels/oauth/shopify/start?shop=acme.myshopify.com", {
      headers: jsonHeaders(testAdminActor),
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: { code: "OAUTH_NOT_CONFIGURED", message: "Channel OAuth is not configured." } });
  });

  it("keeps the state helper timing-safe and signs payloads for the callback", () => {
    const state = signState({ provider: "shopify", orgId: "org-1", shopDomain: "acme.myshopify.com", exp: Math.floor(Date.now() / 1000) + 60, jti: "jti-1" }, STATE_SECRET);
    expect(state.split(".")).toHaveLength(2);
    expect(verifyState(state, STATE_SECRET).ok).toBe(true);
    expect(verifyState(state, STATE_SECRET).ok).toBe(false);
  });
});
