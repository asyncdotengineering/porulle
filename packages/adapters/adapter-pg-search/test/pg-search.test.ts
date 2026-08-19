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

  it("applies AND-across-keys and OR-within-key attribute filters", async () => {
    const documents = new Map<string, Record<string, unknown>>();

    const matches = (sql: string, params: unknown[], document: Record<string, unknown>): boolean => {
      for (const field of ["type", "status"]) {
        const match = sql.match(new RegExp(`${field} = \\$([0-9]+)`));
        if (match && document[field] !== params[Number(match[1]) - 1]) return false;
      }

      for (const field of ["category", "brand"]) {
        const match = sql.match(new RegExp(`\\$([0-9]+) = ANY\\(${field === "category" ? "categories" : "brands"}\\)`));
        if (match) {
          const values = document[field === "category" ? "categories" : "brands"] as string[];
          if (!values.includes(String(params[Number(match[1]) - 1]))) return false;
        }
      }

      const attributes = document.attributes as Record<string, string | string[]>;
      const attributeMatches = [...sql.matchAll(/attributes -> \$([0-9]+)/g)];
      for (const attributeMatch of attributeMatches) {
        const keyIndex = Number(attributeMatch[1]) - 1;
        const key = String(params[keyIndex]);
        const values = [...sql.slice(attributeMatch.index).matchAll(/IN \(([^)]+)\)/g)][0]?.[1]
          ?.split(",")
          .map((placeholder) => params[Number(placeholder.trim().slice(1)) - 1]);
        const requested = (values ?? []).map(String);
        const actual = attributes[key];
        const actualValues = Array.isArray(actual) ? actual : actual ? [actual] : [];
        if (!requested.some((value) => actualValues.includes(value))) return false;
      }

      return true;
    };

    const adapter = pgSearchAdapter({
      async query(sql, params) {
        if (sql.includes("INSERT INTO")) {
          documents.set(String(params[0]), {
            id: params[0],
            type: params[1],
            status: params[5],
            categories: params[6],
            brands: params[7],
            attributes: JSON.parse(String(params[9])),
          });
          return { rows: [] };
        }

        const filtered = [...documents.values()].filter((document) => matches(sql, params, document));
        if (sql.includes("COUNT(*)")) return { rows: [{ total: filtered.length }] };
        if (sql.includes("SELECT id, type, slug") && sql.includes("AS score")) {
          return {
            rows: filtered.map((document) => ({
              ...document,
              slug: document.id,
              title: document.id,
              categories: document.categories,
              brands: document.brands,
              text: document.id,
              attributes: document.attributes,
              score: 0,
            })),
          };
        }
        if (sql.includes("SELECT id, type, slug")) {
          return {
            rows: filtered.map((document) => ({
              ...document,
              slug: document.id,
              title: document.id,
              categories: document.categories,
              brands: document.brands,
              text: document.id,
              attributes: document.attributes,
            })),
          };
        }
        return { rows: [] };
      },
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
  });
});
