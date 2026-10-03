/**
 * The adapter inside real workerd, calling Shopify through the runtime's own global `fetch`.
 *
 * workerd's `fetch` refuses to run with a `this` other than the global scope ("Illegal invocation:
 * function called with incorrect `this` reference"); Node's does not care. An adapter that stores
 * `fetch` on an object and calls it as a method therefore passes every Node test and fails every
 * Admin API call on a Worker — the first real store connected through a Worker failed exactly so,
 * at the store-profile read right after OAuth.
 *
 * Nothing is injected: the connector is built with no `fetchImpl`, so it uses the runtime's. The
 * only seam is Miniflare's outbound service, which answers the request the Worker's `fetch` made —
 * after workerd has already accepted or refused the call. What could make this pass without
 * proving anything, written first:
 *   - the request never reaches the outbound service (refused earlier, or never sent) → the test
 *     asserts the outbound service saw the adapter's GraphQL request;
 *   - the profile read fails some other way and the assertion only checks "no Illegal invocation"
 *     → it asserts `ok` and the exact profile fields.
 */
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, type Request as MiniflareRequest } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const graphqlBodySchema = z.object({ query: z.string() }).passthrough();

const ENTRY = `
import { shopifyConnector } from "./src/index.ts";
export default {
  async fetch(request) {
    const connector = shopifyConnector({ clientId: "workerd", clientSecret: "workerd", shopOrigin: () => "https://runvae-dev.myshopify.com" });
    const store = {
      id: "workerd-store",
      organizationId: "workerd-org",
      provider: "shopify",
      credentials: { accessToken: "shpat_workerd", grantedScopes: [] },
      storeDomain: "runvae-dev.myshopify.com",
      status: "connected",
      webhookSecret: null,
    };
    if (new URL(request.url).pathname === "/order") {
      return Response.json(await connector.pushOrder(store, {
        orderId: "order-workerd-1",
        currency: "LKR",
        grandTotal: 980000,
        lines: [{ externalVariantId: "4242", title: "Handloom Cotton Shirt", quantity: 1, unitPrice: 980000, totalPrice: 980000 }],
        customer: {
          name: "Nimali Perera",
          email: "nimali@example.com",
          shippingAddress: { firstName: "Nimali", lastName: "Perera", line1: "12 Galle Road", city: "Colombo", countryCode: "LK", phone: "+94771234567" },
        },
      }));
    }
    return Response.json(await connector.fetchStoreProfile(store));
  },
};
`;

const seen: string[] = [];
const bodies: unknown[] = [];
let mf: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "import"],
    mainFields: ["module", "main"],
    // What wrangler does for a `nodejs_compat` Worker: Node builtins stay runtime imports, and the
    // CommonJS dependencies core pulls in (pino) get a `require` to load them with.
    plugins: [{
      name: "node-builtins",
      setup(b) {
        b.onResolve({ filter: new RegExp(`^(node:)?(${builtinModules.join("|")})(/.*)?$`) }, (args) => ({
          path: args.path.startsWith("node:") ? args.path : `node:${args.path}`,
          external: true,
        }));
      },
    }],
    banner: { js: 'import { createRequire as __workerdCreateRequire } from "node:module"; const require = __workerdCreateRequire("/worker.js");' },
  });
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]?.text ?? "",
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: async (request: MiniflareRequest) => {
      seen.push(`${request.method} ${request.url}`);
      const body = graphqlBodySchema.parse(await request.json());
      bodies.push(body);
      if (body.query.includes("PorulleOrderBySource")) return Response.json({ data: { orders: { nodes: [] } } });
      if (body.query.includes("PorulleOrderCreate")) return Response.json({ data: { orderCreate: { order: { legacyResourceId: "1001" }, userErrors: [] } } });
      return Response.json({
        data: { shop: { name: "runvae dev", currencyCode: "LKR", myshopifyDomain: "runvae-dev.myshopify.com", primaryDomain: { host: "runvae-dev.myshopify.com" } } },
      });
    },
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("shopifyConnector on workerd with the runtime's own fetch", () => {
  it("reads the store profile", async () => {
    seen.length = 0;
    const response = await mf.dispatchFetch("https://worker.test/");
    const result: unknown = await response.json();
    expect(result).toEqual({
      ok: true,
      value: { name: "runvae dev", currency: "LKR", storefrontHosts: ["runvae-dev.myshopify.com"] },
    });
    expect(seen).toEqual(["POST https://runvae-dev.myshopify.com/admin/api/2026-10/graphql.json"]);
  });

  // orderCreate's `requiresShipping` defaults to FALSE (Shopify's OrderCreateLineItemInput). Left
  // out, a real store showed the first exported order as "Shipping not required" although it carried
  // the shopper's address, so the merchant could not ship it the normal way. Every marketplace order
  // carries a shipping address, so every line ships.
  it("pushes an order whose every line requires shipping", async () => {
    bodies.length = 0;
    const response = await mf.dispatchFetch("https://worker.test/order");
    expect(await response.json()).toEqual({ ok: true, value: { remoteOrderId: "1001" } });
    const create = bodies.find((body): body is { variables: { order: { lineItems: { requiresShipping?: unknown }[] } } } =>
      typeof body === "object" && body !== null && "query" in body && String(body.query).includes("PorulleOrderCreate"));
    expect(create?.variables.order.lineItems).toHaveLength(1);
    expect(create?.variables.order.lineItems.map((line) => line.requiresShipping)).toEqual([true]);
  });
});
