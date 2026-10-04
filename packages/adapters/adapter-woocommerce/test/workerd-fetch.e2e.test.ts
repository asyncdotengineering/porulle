/**
 * The adapter inside real workerd, calling a store through the runtime's own global `fetch`.
 *
 * workerd refuses a `fetch` called with a `this` other than the global scope ("Illegal invocation"),
 * which Node does not care about; and the adapter signs webhooks with `node:crypto` and encodes keys
 * with `btoa`, which must exist under `nodejs_compat`. Nothing is injected: the connector is built with
 * no `fetchImpl`. Miniflare's outbound service answers what the Worker's `fetch` sent — after workerd
 * accepted the call. What could make this pass without proving anything, written first:
 *   - the request never leaves the Worker → the outbound service must have seen the GET and its Basic header;
 *   - the read fails some other way → the exact inventory level is asserted.
 */
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, type Request as MiniflareRequest } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const KEY = `ck_${"a".repeat(40)}`;
const SECRET = `cs_${"b".repeat(40)}`;

const ENTRY = `
import { wooConnector } from "./src/index.ts";
export default {
  async fetch() {
    const connector = wooConnector();
    const store = {
      id: "workerd-store",
      organizationId: "workerd-org",
      provider: "woocommerce",
      credentials: { consumerKey: "${KEY}", consumerSecret: "${SECRET}", authMode: "header", restRoute: "pretty", currency: "LKR", priceDecimals: 2 },
      storeDomain: "https://shop.example",
      status: "connected",
      webhookSecret: "workerd-secret",
    };
    return Response.json(await connector.fetchInventory(store, ["30"]));
  },
};
`;

const seen: Array<{ request: string; authorization: string | null }> = [];
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
      seen.push({ request: `${request.method} ${request.url}`, authorization: request.headers.get("authorization") });
      return Response.json([{ id: 30, name: "T-Shirt with Logo", type: "simple", manage_stock: true, stock_quantity: 4, stock_status: "instock", variations: [] }]);
    },
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("wooConnector on workerd with the runtime's own fetch", () => {
  it("reads stock with the keys in a Basic header", async () => {
    const response = await mf.dispatchFetch("https://worker.test/");
    expect(await response.json()).toEqual({ ok: true, value: [{ externalId: "30", available: 4 }] });
    expect(seen).toEqual([{ request: "GET https://shop.example/wp-json/wc/v3/products?per_page=100&include=30&status=any&page=1", authorization: `Basic ${btoa(`${KEY}:${SECRET}`)}` }]);
  });
});
