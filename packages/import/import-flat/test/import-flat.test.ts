import { describe, expect, it } from "vitest";
import { importFlat, parseCsv } from "../src/index.js";

describe("import-flat", () => {
  it("parses csv records and imports mapped entities", async () => {
    const csv = [
      "sku,title,brand,weight",
      "shoe-1,Trail Runner,Acme,420",
      "shoe-2,City Runner,Acme,390",
    ].join("\n");

    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);

    const created: Array<{ type: string; slug: string; attributes: { title: string } }> = [];

    const result = await importFlat({
      csv,
      mapping: {
        entityType: "product",
        slug: "sku",
        title: "title",
        metadata: {
          brand: "brand",
        },
        customFields: {
          weight: (row) => Number(row.weight),
        },
      },
      target: {
        async createEntity(input) {
          created.push({ type: input.type, slug: input.slug, attributes: { title: input.attributes.title } });
          return { id: `ent_${created.length}` };
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(2);
    expect(result.value.failed).toBe(0);
    expect(created[0]?.slug).toBe("shoe-1");
    expect(created[1]?.slug).toBe("shoe-2");
  });

  it("returns row-level errors for invalid mappings", async () => {
    const result = await importFlat({
      rows: [{ title: "Missing slug" }],
      mapping: {
        entityType: "product",
        slug: "sku",
        title: "title",
      },
      target: {
        async createEntity() {
          return { id: "ent_1" };
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(0);
    expect(result.value.failed).toBe(1);
    expect(result.value.errors[0]?.message).toContain("Missing slug");
  });
});
