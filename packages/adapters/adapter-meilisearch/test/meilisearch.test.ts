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

  it("applies AND-across-keys and OR-within-key attribute filters", async () => {
    const documents: Array<{
      id: string;
      type: string;
      slug: string;
      title: string;
      categories: string[];
      brands: string[];
      text: string;
      attributes: Record<string, string | string[]>;
    }> = [];
    const filterableUpdates: string[][] = [];

    const matches = (
      filters: string[] | undefined,
      document: (typeof documents)[number],
    ): boolean => {
      return (filters ?? []).every((filter) => {
        const values = [...filter.matchAll(/attributes\.([\w-]+) = "([^"]+)"/g)];
        if (values.length === 0) return true;
        const actual = document.attributes[values[0]![1]!];
        const actualValues = Array.isArray(actual) ? actual : actual ? [actual] : [];
        return values.some((value) => actualValues.includes(value[2]!));
      });
    };

    const index = {
      async updateFilterableAttributes(attributes: string[]) {
        filterableUpdates.push(attributes);
      },
      async addDocuments(nextDocuments: typeof documents) {
        documents.push(...nextDocuments);
      },
      async deleteDocuments() {},
      async search(_query: string, options?: { filter?: string[]; facets?: string[]; limit?: number; offset?: number }) {
        const filtered = documents.filter((document) => matches(options?.filter, document));
        const facetDistribution: Record<string, Record<string, number>> = {};
        for (const facet of options?.facets ?? []) {
          const key = facet.replace(/^attributes\./, "");
          for (const document of filtered) {
            const value = document.attributes[key];
            const values = Array.isArray(value) ? value : value ? [value] : [];
            for (const entry of values) {
              facetDistribution[facet] ??= {};
              facetDistribution[facet]![entry] = (facetDistribution[facet]![entry] ?? 0) + 1;
            }
          }
        }
        return {
          hits: filtered.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 20)),
          estimatedTotalHits: filtered.length,
          facetDistribution,
        };
      },
    };

    const adapter = meilisearchAdapter({
      host: "http://127.0.0.1:7700",
      client: { index: () => index },
    });

    await adapter.index([
      {
        id: "linen-resort",
        type: "product",
        slug: "linen-resort",
        title: "Linen Resort",
        categories: [],
        brands: [],
        text: "Linen Resort",
        attributes: { material: "linen", occasion: "resort" },
      },
      {
        id: "linen-wedding",
        type: "product",
        slug: "linen-wedding",
        title: "Linen Wedding",
        categories: [],
        brands: [],
        text: "Linen Wedding",
        attributes: { material: "linen", occasion: "wedding" },
      },
      {
        id: "cotton-wedding",
        type: "product",
        slug: "cotton-wedding",
        title: "Cotton Wedding",
        categories: [],
        brands: [],
        text: "Cotton Wedding",
        attributes: { material: "cotton", occasion: "wedding" },
      },
    ]);

    const result = await adapter.search({
      query: "",
      filters: { attributes: { material: "linen", occasion: ["resort", "wedding"] } },
      facets: ["material", "occasion"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.hits.map((hit) => hit.id).sort()).toEqual(["linen-resort", "linen-wedding"]);
    expect(result.value.facets).toEqual({
      material: { linen: 2 },
      occasion: { resort: 1, wedding: 1 },
    });
    expect(filterableUpdates[0]).toEqual(
      expect.arrayContaining(["attributes.material", "attributes.occasion"]),
    );
  });

  it("unions stored filterable attributes instead of narrowing them after a restart", async () => {
    const filterableUpdates: string[][] = [];
    const index = {
      async getFilterableAttributes() {
        return ["type", "status", "categories", "brands", "attributes.occasion"];
      },
      async updateFilterableAttributes(attributes: string[]) {
        filterableUpdates.push(attributes);
      },
      async addDocuments() {},
      async deleteDocuments() {},
      async search() {
        return { hits: [] };
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

    const result = await adapter.index([
      {
        id: "ent_1",
        type: "product",
        slug: "linen-shirt",
        title: "Linen Shirt",
        categories: [],
        brands: [],
        text: "Linen Shirt",
        attributes: { material: "linen" },
      },
    ]);
    expect(result.ok).toBe(true);

    expect(filterableUpdates).toHaveLength(1);
    expect(filterableUpdates[0]).toEqual(
      expect.arrayContaining(["attributes.occasion", "attributes.material"]),
    );
  });

  it("refuses attribute names outside the safe pattern instead of injecting into the filter", async () => {
    const searchOptions: any[] = [];
    const index = {
      async updateFilterableAttributes() {},
      async addDocuments() {},
      async deleteDocuments() {},
      async search(_query: string, options?: any) {
        searchOptions.push(options);
        return { hits: [] };
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

    const result = await adapter.search({
      query: "",
      filters: { attributes: { 'x = "a" OR type': "anything" } },
    });
    expect(result.ok).toBe(true);

    const filter = searchOptions[0]?.filter as string[];
    expect(filter).toContain('id = ""');
    expect(filter.join(" ")).not.toContain("OR type");
  });
});
