import { describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { createRestRoutes } from "../src/interfaces/rest/index.js";
import type { SearchAdapter, SearchDocument, SearchQueryParams, SearchSuggestParams } from "../src/modules/search/adapter.js";

const actor = {
  type: "user",
  userId: "staff-1",
  email: "staff@example.com",
  name: "Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
  ],
} as any;

describe("phase 5 search", () => {
  it("supports REST search and suggest with facets", async () => {
    const kernel = createKernel(await createTestConfig());

    const first = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "trail-jacket",
        attributes: {
          title: "Trail Jacket",
          description: "Waterproof alpine shell",
        },
      },
      actor,
    );
    const second = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "city-shoe",
        attributes: {
          title: "City Shoe",
          description: "Everyday commuter shoe",
        },
      },
      actor,
    );

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    await kernel.services.catalog.addToCategory(first.value.id, "outerwear", actor);
    await kernel.services.catalog.addToCategory(second.value.id, "footwear", actor);
    await kernel.services.catalog.addToBrand(first.value.id, "acme", actor);
    await kernel.services.catalog.addToBrand(second.value.id, "globex", actor);

    const app = createRestRoutes(kernel);

    const searchResponse = await app.request(
      "http://localhost/search?q=trail&category=outerwear&brand=acme&facets=type,category,brand",
      { method: "GET" },
    );
    expect(searchResponse.status).toBe(200);

    const searchPayload = await searchResponse.json();
    expect(Array.isArray(searchPayload.data)).toBe(true);
    expect(searchPayload.data.length).toBe(1);
    expect(searchPayload.data[0]?.document?.slug).toBe("trail-jacket");
    expect(searchPayload.meta?.facets?.type?.product).toBeGreaterThanOrEqual(1);
    expect(searchPayload.meta?.facets?.category?.outerwear).toBeGreaterThanOrEqual(1);
    expect(searchPayload.meta?.facets?.brand?.acme).toBeGreaterThanOrEqual(1);

    const suggestResponse = await app.request("http://localhost/search/suggest?prefix=tr", { method: "GET" });
    expect(suggestResponse.status).toBe(200);
    const suggestPayload = await suggestResponse.json();
    expect(suggestPayload.data).toContain("Trail Jacket");
  });

  it("syncs documents to search adapter hooks and uses adapter for free-text queries", async () => {
    const indexedDocs: SearchDocument[] = [];
    const removedIds: string[][] = [];
    const searchCalls: SearchQueryParams[] = [];
    const suggestCalls: SearchSuggestParams[] = [];

    const adapter: SearchAdapter = {
      providerId: "mock-search",
      async index(documents) {
        indexedDocs.push(...documents);
        return { ok: true, value: undefined };
      },
      async remove(ids) {
        removedIds.push(ids);
        return { ok: true, value: undefined };
      },
      async search(params) {
        searchCalls.push(params);
        return {
          ok: true,
          value: {
            hits: indexedDocs.slice(0, 1).map((document) => ({ id: document.id, score: 1, document })),
            total: indexedDocs.length,
            page: params.page ?? 1,
            limit: params.limit ?? 20,
            facets: {
              type: { product: indexedDocs.filter((document) => document.type === "product").length },
            },
          },
        };
      },
      async suggest(params) {
        suggestCalls.push(params);
        return {
          ok: true,
          value: indexedDocs
            .map((document) => document.title)
            .filter((title) => title.toLowerCase().startsWith(params.prefix.toLowerCase()))
            .slice(0, params.limit ?? 10),
        };
      },
    };

    const kernel = createKernel(
      await createTestConfig({
        search: {
          adapter,
        },
      }),
    );

    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "search-hook-product",
        attributes: {
          title: "Search Hook Product",
        },
      },
      actor,
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(indexedDocs.some((document) => document.id === created.value.id)).toBe(true);
    expect(removedIds).toHaveLength(0);

    const searchResult = await kernel.services.search.query({
      query: "search",
      page: 1,
      limit: 5,
      filters: { type: "product" },
    });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    expect(searchCalls.length).toBe(1);
    expect(searchCalls[0]?.query).toBe("search");
    expect(searchResult.value.hits[0]?.document?.slug).toBe("search-hook-product");

    const suggest = await kernel.services.search.suggest({ prefix: "se" });
    expect(suggest.ok).toBe(true);
    if (!suggest.ok) return;
    expect(suggest.value).toContain("Search Hook Product");
    expect(suggestCalls.length).toBe(1);
  });
});
