/**
 * db.execute() result-shape normalization (#11)
 *
 * postgres-js returns rows as an array; neon-http / node-postgres / PGlite
 * return `{ rows, command, rowCount }`. createDatabaseConnection normalizes
 * execute() to always return the row array, so raw-SQL code is driver-agnostic.
 */

import { describe, it, expect } from "vitest";
import { createDatabaseConnection, unwrapDb } from "../src/kernel/database/adapter.js";

function fakeAdapter(executeResult: unknown, txExecuteResult: unknown) {
  return {
    provider: "postgresql",
    db: {
      marker: "real-db",
      whoAmI(): string {
        // Relies on `this` being the real driver instance, not the proxy.
        return this.marker;
      },
      async execute() {
        return executeResult;
      },
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async execute() {
          return txExecuteResult;
        },
      };
      return fn(tx);
    },
  };
}

describe("db.execute() result-shape normalization (#11)", () => {
  it("unwraps { rows } to an array (neon-http / node-postgres / PGlite shape)", async () => {
    const conn = createDatabaseConnection({
      adapter: fakeAdapter({ rows: [{ a: 1 }], command: "SELECT", rowCount: 1 }, null),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (conn.db as any).execute("SELECT 1");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ a: 1 }]);
  });

  it("leaves an array result unchanged (postgres-js shape)", async () => {
    const conn = createDatabaseConnection({ adapter: fakeAdapter([{ a: 1 }], null) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (conn.db as any).execute("SELECT 1");
    expect(result).toEqual([{ a: 1 }]);
  });

  it("normalizes execute inside a transaction handle too", async () => {
    const conn = createDatabaseConnection({ adapter: fakeAdapter(null, { rows: [{ b: 2 }] }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await conn.transaction(async (tx) => (tx as any).execute("SELECT 2"));
    expect(result).toEqual([{ b: 2 }]);
  });

  it("preserves other methods and their `this` binding", async () => {
    const conn = createDatabaseConnection({ adapter: fakeAdapter([], null) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((conn.db as any).whoAmI()).toBe("real-db");
  });

  it("unwrapDb() returns the raw driver (so drizzle-kit gets the native shape)", () => {
    const adapter = fakeAdapter([], null);
    const conn = createDatabaseConnection({ adapter });
    expect(conn.db).not.toBe(adapter.db); // normalized proxy
    expect(unwrapDb(conn.db)).toBe(adapter.db); // raw driver back
    expect(unwrapDb(adapter.db)).toBe(adapter.db); // unwrapped is a no-op
  });
});
