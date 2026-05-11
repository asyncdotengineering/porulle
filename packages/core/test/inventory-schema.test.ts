import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

function rows<T extends Record<string, unknown>>(raw: unknown): T[] {
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  if (
    raw &&
    typeof raw === "object" &&
    "rows" in raw &&
    Array.isArray((raw as { rows: unknown }).rows)
  ) {
    return (raw as { rows: T[] }).rows;
  }
  return [];
}

describe("inventory schema (PGlite push)", () => {
  let cleanup: () => Promise<void>;
  let db: Awaited<ReturnType<typeof createPGliteTestAdapter>>["db"];

  beforeAll(async () => {
    const adapter = await createPGliteTestAdapter();
    db = adapter.db;
    cleanup = adapter.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("defines organization_id NOT NULL on inventory_levels and inventory_movements", async () => {
    for (const table of ["inventory_levels", "inventory_movements"] as const) {
      const meta = rows<{ attname: string; attnotnull: boolean }>(
        await db.execute(sql`
          SELECT a.attname, a.attnotnull
          FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
          JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
          WHERE n.nspname = 'public'
            AND c.relname = ${table}
            AND a.attname = 'organization_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
        `),
      );
      expect(meta).toHaveLength(1);
      expect(meta[0]!.attnotnull).toBe(true);
    }

    const levelIdx = rows<{ indexname: string }>(
      await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'inventory_levels' AND indexname = 'idx_inventory_levels_org'
      `),
    );
    expect(levelIdx).toHaveLength(1);

    const movementIdx = rows<{ indexname: string }>(
      await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'inventory_movements' AND indexname = 'idx_inventory_movements_org'
      `),
    );
    expect(movementIdx).toHaveLength(1);
  });
});
