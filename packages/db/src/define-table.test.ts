import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { defineTable } from "./define-table.js";
import { column } from "./column.js";

function uniqueIndexColumnNames(table: PgTable) {
  const { indexes } = getTableConfig(table);
  return indexes
    .filter((idx) => idx.config.unique)
    .map((idx) => ({
      name: idx.config.name,
      columns: idx.config.columns.map((col) => {
        if (col && typeof col === "object" && "name" in col && col.name) {
          return col.name as string;
        }
        return null;
      }),
    }));
}

describe("defineTable", () => {
  it("auto-injects id, organizationId, createdAt, updatedAt on top-level tables", () => {
    const table = defineTable("test_products", {
      name: column.text(),
      price: column.integer(),
    });

    const cols = getTableColumns(table);
    expect(cols).toHaveProperty("id");
    expect(cols).toHaveProperty("organizationId");
    expect(cols).toHaveProperty("createdAt");
    expect(cols).toHaveProperty("updatedAt");
    expect(cols).toHaveProperty("name");
    expect(cols).toHaveProperty("price");
  });

  it("marks top-level tables as __ucOrgScoped", () => {
    const table = defineTable("test_items", {
      title: column.text(),
    });
    expect((table as Record<string, unknown>).__ucOrgScoped).toBe(true);
  });

  it("detects child tables (FK to org-scoped parent) and skips organizationId", () => {
    const parent = defineTable("test_parent", {
      slug: column.text({ unique: true }),
    });

    const child = defineTable("test_child", {
      parentId: column.uuid({ references: parent }),
      note: column.text({ optional: true }),
    });

    const parentCols = getTableColumns(parent);
    const childCols = getTableColumns(child);

    // Parent has organizationId
    expect(parentCols).toHaveProperty("organizationId");
    // Child does NOT
    expect(childCols).not.toHaveProperty("organizationId");
    // Child has id + createdAt but no updatedAt
    expect(childCols).toHaveProperty("id");
    expect(childCols).toHaveProperty("createdAt");
    expect(childCols).not.toHaveProperty("updatedAt");
    // Child is not org-scoped
    expect((child as Record<string, unknown>).__ucOrgScoped).toBe(false);
  });

  it("supports all column types", () => {
    const table = defineTable("test_all_types", {
      name: column.text(),
      count: column.integer({ default: 0 }),
      active: column.boolean({ default: true }),
      data: column.json({ default: {} }),
      happenedAt: column.timestamp({ optional: true }),
    });

    const cols = getTableColumns(table);
    expect(cols).toHaveProperty("name");
    expect(cols).toHaveProperty("count");
    expect(cols).toHaveProperty("active");
    expect(cols).toHaveProperty("data");
    expect(cols).toHaveProperty("happenedAt");
  });

  it("supports enum columns", () => {
    const table = defineTable("test_enum", {
      status: column.text({ enum: ["active", "disabled", "exhausted"], default: "active" }),
    });

    const cols = getTableColumns(table);
    expect(cols).toHaveProperty("status");
  });

  it("SEC-03: honors unique on child tables via UNIQUE (col)", () => {
    const parent = defineTable("sec03_parent", {
      slug: column.text({ unique: true }),
    });

    const child = defineTable("sec03_child", {
      parentId: column.uuid({ references: parent }),
      code: column.text({ unique: true }),
    });

    const uniqueIndexes = uniqueIndexColumnNames(child);
    expect(uniqueIndexes).toHaveLength(1);
    expect(uniqueIndexes[0]?.columns).toEqual(["code"]);
    expect(uniqueIndexes[0]?.name).toBe("sec03_child_code_unique");
  });

  it("SEC-04: unique true is per-org composite; unique global is single-column", () => {
    const perOrg = defineTable("sec04_per_org", {
      sku: column.text({ unique: true }),
    });

    const perOrgIndexes = uniqueIndexColumnNames(perOrg);
    expect(perOrgIndexes).toHaveLength(1);
    expect(perOrgIndexes[0]?.columns).toEqual(["organization_id", "sku"]);
    expect(perOrgIndexes[0]?.name).toBe("sec04_per_org_org_sku_unique");

    const global = defineTable("sec04_global", {
      publicCode: column.text({ unique: "global" }),
    });

    const globalIndexes = uniqueIndexColumnNames(global);
    expect(globalIndexes).toHaveLength(1);
    expect(globalIndexes[0]?.columns).toEqual(["public_code"]);
    expect(globalIndexes[0]?.name).toBe("sec04_global_public_code_unique");
  });
});
