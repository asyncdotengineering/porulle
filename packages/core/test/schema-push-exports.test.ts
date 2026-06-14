/**
 * Schema-push public exports (#26)
 *
 * The migrate module's docstring promises npm consumers `getSchemaFiles()`
 * and `pushSchema()`, but the public entry historically only re-exported
 * `getSchema`/`buildSchema`/`getTableNames`. These tests assert the two
 * symbols are importable from the package entry (`@porulle/core`) and that
 * `pushSchema()` actually creates the core tables in a fresh database.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
// Import from the PUBLIC entry barrel — this is the contract under test.
import { getSchemaFiles, pushSchema } from "../src/index.js";
import * as fullSchema from "../src/kernel/database/schema.js";

describe("schema-push public exports (#26)", () => {
  it("exposes getSchemaFiles and pushSchema from the package entry", () => {
    expect(typeof getSchemaFiles).toBe("function");
    expect(typeof pushSchema).toBe("function");
  });

  it("getSchemaFiles() returns existing absolute schema module path(s)", () => {
    const files = getSchemaFiles();
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/schema\.(js|ts)$/);
      expect(existsSync(file)).toBe(true);
    }
  });

  it("pushSchema() creates the core tables in a fresh database", async () => {
    const pg = new PGlite();
    const db = drizzle(pg, { schema: fullSchema });

    await pushSchema(db);

    // A representative core table must now exist and be selectable.
    const result = await db.execute(
      sql`SELECT to_regclass('public.sellable_entities') AS table_name`,
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
      table_name: string | null;
    }>;
    expect(rows[0]?.table_name).toBe("sellable_entities");
  });
});
