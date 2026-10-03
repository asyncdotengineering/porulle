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
  const base = mockChannelConnector({ catalog: [] });
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

/** The outcome query a callback lands the merchant's browser on. */
function outcome(response: Response): URLSearchParams {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  return location.searchParams;
}

describe("channel connector OAuth routes", () => {
  let built: Awaited<ReturnType<typeof createPluginTestApp>>;
  let withoutOAuth: Awaited<ReturnType<typeof createPluginTestApp>>;
  /** Every binding the host was asked for, and a switch to make it refuse. */
  const bindings: Array<{ storeId: string; userId: string | null; claims: Readonly<Record<string, string>> }> = [];
  let refuseBinding = false;
  let refuseClaims = false;

  beforeAll(async () => {
    const shopify = oauthConnector("shopify");
    const woo = oauthConnector("woocommerce");
    const pluginOptions = {
      connectors: [shopify, woo],
      oauth: { stateSecret: STATE_SECRET, postConnectRedirect: REDIRECT },
      // What the host resolves at START from the request that has the session and headers; the
      // callback has neither, so this must reach the binding through the signed state.
      connectClaims: () => {
        if (refuseClaims) throw new Error("Choose the vendor this store belongs to.");
        return { vendorId: "vendor-from-start" };
      },
      bindConnectedStore: async ({ store, actor }: { store: { id: string }; actor: { userId: string | null; claims: Readonly<Record<string, string>> } }) => {
        if (refuseBinding) throw new Error("This user is not a member of any vendor.");
        bindings.push({ storeId: store.id, userId: actor.userId, claims: actor.claims });
      },
    };
    built = await createPluginTestApp(channelConnectorPlugin(pluginOptions));
    withoutOAuth = await createPluginTestApp(channelConnectorPlugin({ connectors: [shopify] }));
  }, 120_000);

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
    const stores = await built.db.select().from(connectedStores).where(eq(connectedStores.storeDomain, "acme.myshopify.com"));
    expect(stores).toHaveLength(1);
    expect(outcome(callback).get("connected")).toBe(stores[0]?.id);
    // Bound to the user who STARTED the connection — the callback itself carries no session.
    expect(bindings).toContainEqual({ storeId: stores[0]?.id, userId: testAdminActor.userId, claims: { vendorId: "vendor-from-start" } });
    expect(stores[0]?.credentials).toEqual({ accessToken: "oauth-token" });
    // The OAuth connect starts no import either; the host's operator route does.
    const jobsRaw = await built.db.execute(sql`
      SELECT task_slug FROM commerce_jobs WHERE concurrency_key = ${stores[0]?.id ?? ""}
    `);
    const jobs = Array.isArray(jobsRaw) ? jobsRaw : ((jobsRaw as { rows?: unknown[] }).rows ?? []);
    expect(jobs).toEqual([]);
  });

  it("rejects OAuth state replay and expiry", async () => {
    const start = await built.app.request("http://localhost/api/channels/oauth/shopify/start?shop=second.myshopify.com", {
      headers: jsonHeaders(testAdminActor),
    });
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect(outcome(await built.app.request(shopifyCallbackUrl(state))).get("connected")).toBeTruthy();
    expect(outcome(await built.app.request(shopifyCallbackUrl(state))).get("connect_error")).toBe("OAUTH_STATE_REPLAYED");

    const expired = signState({
      provider: "shopify",
      orgId: testAdminActor.organizationId ?? "",
      userId: testAdminActor.userId ?? "",
      claims: {},
      shopDomain: "expired.myshopify.com",
      exp: Math.floor(Date.now() / 1000) - 1,
      jti: crypto.randomUUID(),
    }, STATE_SECRET);
    expect(outcome(await built.app.request(shopifyCallbackUrl(expired))).get("connect_error")).toBe("INVALID_OAUTH_STATE");
  });

  it("refuses to start a connection the host's claims refuse, before anything is signed", async () => {
    refuseClaims = true;
    try {
      const start = await built.app.request("http://localhost/api/channels/oauth/shopify/start?shop=unclaimed.myshopify.com", { headers: jsonHeaders(testAdminActor) });
      const landed = outcome(start);
      expect(landed.get("connect_error")).toBe("CONNECT_REFUSED");
      expect(landed.get("connect_message")).toContain("Choose the vendor");
    } finally {
      refuseClaims = false;
    }
  });

  it("writes no store when the host refuses to bind it, and says why", async () => {
    refuseBinding = true;
    try {
      const start = await built.app.request("http://localhost/api/channels/oauth/shopify/start?shop=unbound.myshopify.com", { headers: jsonHeaders(testAdminActor) });
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const url = new URL(shopifyCallbackUrl(state));
      url.searchParams.set("shop", "unbound.myshopify.com");
      const landed = outcome(await built.app.request(url.toString()));
      expect(landed.get("connect_error")).toBe("STORE_CONNECTION_REFUSED");
      expect(landed.get("connect_message")).toContain("not a member of any vendor");
      expect(await built.db.select().from(connectedStores).where(eq(connectedStores.storeDomain, "unbound.myshopify.com"))).toHaveLength(0);
    } finally {
      refuseBinding = false;
    }
  });

  it("reconnecting a shop refreshes its one row instead of adding a second", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const start = await built.app.request("http://localhost/api/channels/oauth/shopify/start?shop=twice.myshopify.com", { headers: jsonHeaders(testAdminActor) });
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const url = new URL(shopifyCallbackUrl(state));
      url.searchParams.set("shop", "twice.myshopify.com");
      expect(outcome(await built.app.request(url.toString())).get("connected")).toBeTruthy();
    }
    expect(await built.db.select().from(connectedStores).where(eq(connectedStores.storeDomain, "twice.myshopify.com"))).toHaveLength(1);
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
    expect(outcome(callback).get("connected")).toBeTruthy();
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
    const state = signState({ provider: "shopify", orgId: "org-1", userId: "user-1", claims: {}, shopDomain: "acme.myshopify.com", exp: Math.floor(Date.now() / 1000) + 60, jti: "jti-1" }, STATE_SECRET);
    expect(state.split(".")).toHaveLength(2);
    expect(verifyState(state, STATE_SECRET).ok).toBe(true);
    expect(verifyState(`${state}x`, STATE_SECRET).ok).toBe(false);
  });
});
