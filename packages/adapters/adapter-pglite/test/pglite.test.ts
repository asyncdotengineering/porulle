import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { pgliteAdapter } from "../src/index.js";

type Executable = { execute(q: unknown): Promise<{ rows: Array<Record<string, unknown>> }> };

describe("pgliteAdapter", () => {
  it("boots an in-process Postgres, pushes the core schema, and seeds the default org", async () => {
    const adapter = await pgliteAdapter();
    expect(adapter.provider).toBe("postgresql");

    const db = adapter.db as Executable;

    // Core schema was pushed → a known core table exists.
    const table = await db.execute(sql`SELECT to_regclass('public.organization') AS t`);
    expect(table.rows[0]?.t).toBeTruthy();

    // Default org was seeded.
    const orgs = await db.execute(sql`SELECT count(*)::int AS n FROM organization`);
    expect(Number(orgs.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it("commits a successful transaction and rolls back a failing one", async () => {
    const adapter = await pgliteAdapter();
    const db = adapter.db as Executable;

    await adapter.transaction(async () => {
      await db.execute(sql`CREATE TABLE _tx_probe (id int)`);
      await db.execute(sql`INSERT INTO _tx_probe (id) VALUES (1)`);
    });
    const kept = await db.execute(sql`SELECT count(*)::int AS n FROM _tx_probe`);
    expect(Number(kept.rows[0]?.n)).toBe(1);

    await expect(
      adapter.transaction(async () => {
        await db.execute(sql`INSERT INTO _tx_probe (id) VALUES (2)`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const afterRollback = await db.execute(sql`SELECT count(*)::int AS n FROM _tx_probe`);
    expect(Number(afterRollback.rows[0]?.n)).toBe(1); // the rolled-back insert is gone
  });

  it("skips migration when migrate:false", async () => {
    const adapter = await pgliteAdapter({ migrate: false, seedDefaultOrg: false });
    const db = adapter.db as Executable;
    const table = await db.execute(sql`SELECT to_regclass('public.organization') AS t`);
    expect(table.rows[0]?.t).toBeNull();
  });
});
