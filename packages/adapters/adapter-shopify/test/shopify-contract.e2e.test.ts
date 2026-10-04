/**
 * The adapter against REAL Shopify — no stub, no fixture.
 *
 * Shopify runs a public GraphQL Admin API proxy for its documentation's explorer, answering for a
 * live demo store (`graphql-admin.myshopify.com`). Two things are proven against it:
 *
 *  1. Every document the adapter sends — queries AND mutations — validates against Shopify's own
 *     schema for the pinned version, introspected live. A field Shopify renamed or removed fails here,
 *     not in a merchant's import.
 *  2. The read paths run end to end on Shopify's real responses: catalogue pages, the fresh re-read a
 *     webhook triggers, inventory both ways, and the store profile.
 *
 * The only seam is the one production has: `shopOrigin` points the adapter at an origin, and the
 * proxy is reached at the path the adapter appends. What could make this pass without proving
 * anything, written first:
 *   - the proxy answers errors and the adapter returns an empty page → every read asserts `ok` AND a
 *     non-empty result;
 *   - pagination returns the same page twice → page 2's ids must be disjoint from page 1's;
 *   - the webhook re-read returns different products → compared id-for-id with the imported ones.
 */
import { buildClientSchema, parse, validate } from "graphql";
import type { IntrospectionQuery } from "graphql";
import { getIntrospectionQuery } from "graphql";
import { describe, expect, it } from "vitest";
import {
  CATALOG_ITEMS_QUERY,
  CATALOG_PAGE_QUERY,
  INVENTORY_QUERY,
  ORDER_BY_SOURCE_QUERY,
  ORDER_CREATE_MUTATION,
  ORDER_CANCEL_MUTATION,
  ORDER_FULFILLMENT_LINES_QUERY,
  RETURN_REQUEST_MUTATION,
  RETURN_REASON_QUERY,
  ORDER_STATUS_QUERY,
  SHOPIFY_API_VERSION,
  STORE_PROFILE_QUERY,
  VARIANTS_PAGE_QUERY,
  VARIANT_INVENTORY_QUERY,
  shopifyConnector,
} from "../src/index.js";

const PROXY = `https://shopify.dev/admin-graphql-direct-proxy/${SHOPIFY_API_VERSION}`;
const DEMO_SHOP = "graphql-admin.myshopify.com";
const STAND_IN_ORIGIN = "https://shopify-public-proxy.test";

/** Forwards the adapter's own request to the proxy. Anything else it sends is a defect, and throws. */
const proxyFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url !== `${STAND_IN_ORIGIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`) throw new Error(`unexpected request ${url}`);
  return fetch(PROXY, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body ?? null });
};

const connector = shopifyConnector({ clientId: "contract", clientSecret: "contract", fetchImpl: proxyFetch, shopOrigin: () => STAND_IN_ORIGIN });
const store = {
  id: "contract-store",
  organizationId: "contract-org",
  provider: "shopify",
  credentials: { accessToken: "public-proxy-needs-none", grantedScopes: [] },
  storeDomain: DEMO_SHOP,
  status: "connected" as const,
  webhookSecret: null,
};

describe(`Shopify Admin API ${SHOPIFY_API_VERSION} contract (live)`, { timeout: 120_000 }, () => {
  it("every document the adapter sends validates against Shopify's published schema", async () => {
    const response = await fetch(PROXY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: getIntrospectionQuery() }) });
    const body = await response.json() as { data: IntrospectionQuery };
    const schema = buildClientSchema(body.data);
    const documents = { CATALOG_PAGE_QUERY, VARIANTS_PAGE_QUERY, CATALOG_ITEMS_QUERY, INVENTORY_QUERY, VARIANT_INVENTORY_QUERY, STORE_PROFILE_QUERY, ORDER_CREATE_MUTATION, ORDER_CANCEL_MUTATION, ORDER_FULFILLMENT_LINES_QUERY, RETURN_REQUEST_MUTATION, RETURN_REASON_QUERY, ORDER_BY_SOURCE_QUERY, ORDER_STATUS_QUERY };
    const failures = Object.entries(documents).flatMap(([name, document]) => validate(schema, parse(document)).map((error) => `${name}: ${error.message}`));
    expect(failures).toEqual([]);
  });

  it("reads the store profile Shopify attests to", async () => {
    const profile = await connector.fetchStoreProfile!(store);
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;
    expect(profile.value.storefrontHosts).toContain(DEMO_SHOP);
    expect(profile.value.currency).toMatch(/^[A-Z]{3}$/);
  });

  it("imports catalogue pages, re-reads the same products by id, and reads their stock", async () => {
    const first = await connector.importCatalog(store);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const items = first.value.items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.externalId).toMatch(/^\d+$/);
      expect(item.slug.length).toBeGreaterThan(0);
      expect(item.variants.length).toBeGreaterThan(0);
      for (const variant of item.variants) {
        expect(variant.externalId).toMatch(/^\d+$/);
        expect(variant.metadata?.inventoryItemId).toMatch(/^\d+$/);
        expect(variant.prices?.[0]?.currency).toMatch(/^[A-Z]{3}$/);
        expect(Number.isInteger(variant.prices?.[0]?.amount)).toBe(true);
      }
    }

    if (first.value.nextCursor) {
      const second = await connector.importCatalog(store, first.value.nextCursor);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const firstIds = new Set(items.map((item) => item.externalId));
      expect(second.value.items.some((item) => firstIds.has(item.externalId))).toBe(false);
    }

    const sample = items.slice(0, 3);
    const reread = await connector.fetchCatalogItems!(store, sample.map((item) => item.externalId));
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.map((item) => [item.externalId, item.title])).toEqual(sample.map((item) => [item.externalId, item.title]));

    const variantIds = sample.flatMap((item) => item.variants.map((variant) => variant.externalId));
    const levels = await connector.fetchInventory(store, variantIds);
    expect(levels.ok).toBe(true);
    if (!levels.ok) return;
    expect(levels.value.map((entry) => entry.externalId).sort()).toEqual([...variantIds].sort());
    expect(levels.value.every((entry) => entry.available >= 0)).toBe(true);
  });

  it("walks inventory a page at a time", async () => {
    const page = await connector.fetchInventoryPage!(store, null);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.levels.length).toBeGreaterThan(0);
    expect(page.value.levels.every((entry) => /^\d+$/.test(entry.externalId))).toBe(true);
  });
});
