import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { defineTable } from "./define-table.js";
import { column } from "./column.js";

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
});
