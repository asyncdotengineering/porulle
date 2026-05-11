import { describe, expect, it } from "vitest";
import { meilisearchAdapter } from "../src/index.js";

describe("adapter-meilisearch", () => {
  it("indexes, searches with facets, and suggests titles", async () => {
    const calls: Array<{ name: string; payload?: unknown }> = [];

    const index = {
      async updateFilterableAttributes(attributes: string[]) {
        calls.push({ name: "updateFilterableAttributes", payload: attributes });
      },
      async addDocuments(documents: any[]) {
        calls.push({ name: "addDocuments", payload: documents });
      },
      async deleteDocuments(ids: string[]) {
        calls.push({ name: "deleteDocuments", payload: ids });
      },
      async search(query: string, options?: any) {
        calls.push({ name: "search", payload: { query, options } });
        return {
          hits: [
            {
              id: "ent_1",
              type: "product",
              slug: "trail-jacket",
              title: "Trail Jacket",
              categories: ["jackets"],
              brands: ["acme"],
              text: "Trail Jacket",
              _rankingScore: 0.92,
            },
          ],
          estimatedTotalHits: 1,
          facetDistribution: {
            type: { product: 1 },
          },
        };
      },
    };

    const adapter = meilisearchAdapter({
      host: "http://127.0.0.1:7700",
      client: {
        index() {
          return index;
        },
      },
    });

    const indexed = await adapter.index([
      {
        id: "ent_1",
        type: "product",
        slug: "trail-jacket",
        title: "Trail Jacket",
        categories: ["jackets"],
        brands: ["acme"],
        text: "Trail Jacket",
      },
    ]);
    expect(indexed.ok).toBe(true);

    const searched = await adapter.search({
      query: "trail",
      page: 1,
      limit: 20,
      filters: { type: "product", category: "jackets", brand: "acme" },
      facets: ["type"],
    });

    expect(searched.ok).toBe(true);
    if (!searched.ok) return;

    expect(searched.value.total).toBe(1);
    expect(searched.value.hits[0]?.document.title).toBe("Trail Jacket");
    expect(searched.value.facets.type?.product).toBe(1);

    const suggested = await adapter.suggest({ prefix: "tr", limit: 5 });
    expect(suggested.ok).toBe(true);
    if (!suggested.ok) return;
    expect(suggested.value).toContain("Trail Jacket");

    const removed = await adapter.remove(["ent_1"]);
    expect(removed.ok).toBe(true);

    expect(calls.some((call) => call.name === "addDocuments")).toBe(true);
    expect(calls.some((call) => call.name === "search")).toBe(true);
    expect(calls.some((call) => call.name === "deleteDocuments")).toBe(true);
  });
});
