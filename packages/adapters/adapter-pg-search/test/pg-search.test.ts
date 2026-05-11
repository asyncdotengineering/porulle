import { describe, expect, it } from "vitest";
import { pgSearchAdapter } from "../src/index.js";

describe("adapter-pg-search", () => {
  it("builds SQL for index/search/suggest/remove flows", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];

    const adapter = pgSearchAdapter({
      async query(sql, params) {
        statements.push({ sql, params });

        if (sql.includes("SELECT COUNT(*)::int AS total")) {
          return { rows: [{ total: 1 }] };
        }

        if (sql.includes("SELECT id, type, slug") && sql.includes("AS score")) {
          return {
            rows: [
              {
                id: "ent_1",
                type: "product",
                slug: "trail-jacket",
                title: "Trail Jacket",
                description: "Waterproof",
                status: "active",
                categories: ["jackets"],
                brands: ["acme"],
                text: "Trail Jacket Waterproof",
                payload: { source: "seed" },
                score: 0.98,
              },
            ],
          };
        }

        if (sql.includes("SELECT id, type, slug") && !sql.includes("AS score")) {
          return {
            rows: [
              {
                id: "ent_1",
                type: "product",
                slug: "trail-jacket",
                title: "Trail Jacket",
                description: "Waterproof",
                status: "active",
                categories: ["jackets"],
                brands: ["acme"],
                text: "Trail Jacket Waterproof",
                payload: { source: "seed" },
              },
            ],
          };
        }

        if (sql.includes("SELECT DISTINCT title")) {
          return { rows: [{ title: "Trail Jacket" }] };
        }

        return { rows: [] };
      },
    });

    const indexed = await adapter.index([
      {
        id: "ent_1",
        type: "product",
        slug: "trail-jacket",
        title: "Trail Jacket",
        description: "Waterproof",
        status: "active",
        categories: ["jackets"],
        brands: ["acme"],
        text: "Trail Jacket Waterproof",
        payload: { source: "seed" },
      },
    ]);
    expect(indexed.ok).toBe(true);

    const searched = await adapter.search({
      query: "trail",
      filters: { type: "product", category: "jackets", brand: "acme" },
      page: 1,
      limit: 20,
      facets: ["type", "category", "brand"],
    });

    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(searched.value.total).toBe(1);
    expect(searched.value.hits[0]?.document.title).toBe("Trail Jacket");
    expect(searched.value.facets.type?.product).toBe(1);
    expect(searched.value.facets.category?.jackets).toBe(1);
    expect(searched.value.facets.brand?.acme).toBe(1);

    const suggested = await adapter.suggest({ prefix: "tr", type: "product", limit: 5 });
    expect(suggested.ok).toBe(true);
    if (!suggested.ok) return;
    expect(suggested.value).toEqual(["Trail Jacket"]);

    const removed = await adapter.remove(["ent_1"]);
    expect(removed.ok).toBe(true);

    expect(statements.some((statement) => statement.sql.includes("INSERT INTO search_index"))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes("plainto_tsquery"))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes("DELETE FROM search_index"))).toBe(true);
  });
});
