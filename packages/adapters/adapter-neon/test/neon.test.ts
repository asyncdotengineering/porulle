import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #55 — no first-party Neon/Workers adapter existed; integrators
// hand-rolled hybrid adapters (ordereka's hyperdrive-adapter.ts). These tests
// verify the adapter's orchestration: HTTP driver for plain queries, a FRESH
// WebSocket Pool per transaction (created inside, ended after), Hyperdrive
// connection-string routing for pools, and postgres-js-shaped `.execute()`.

const poolInstances: Array<{ connectionString: string; ended: boolean }> = [];

vi.mock("@neondatabase/serverless", () => {
  class Pool {
    connectionString: string;
    ended = false;
    constructor(opts: { connectionString: string }) {
      this.connectionString = opts.connectionString;
      poolInstances.push(this);
    }
    async end() {
      this.ended = true;
    }
  }
  return {
    Pool,
    neon: vi.fn(() => ({ __tag: "neon-http-sql" })),
    neonConfig: {},
  };
});

vi.mock("drizzle-orm/neon-http", () => ({
  drizzle: vi.fn(() => ({
    __driver: "http",
    execute: vi.fn(async () => ({ rows: [{ ok: 1 }], command: "SELECT", rowCount: 1 })),
  })),
}));

vi.mock("drizzle-orm/neon-serverless", () => ({
  drizzle: vi.fn((pool: unknown) => ({
    __driver: "ws",
    __pool: pool,
    execute: vi.fn(async () => ({ rows: [{ tx: 1 }] })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ __tx: true, execute: async () => ({ rows: [{ inTx: 1 }] }) }),
    ),
  })),
}));

import { neonAdapter, normalizeExecuteShape } from "../src/index.js";

beforeEach(() => {
  poolInstances.length = 0;
});

describe("@porulle/adapter-neon", () => {
  it("exposes a postgresql DatabaseAdapter with postgres-js-shaped execute()", async () => {
    const adapter = neonAdapter({ connectionString: "postgresql://user@x.neon.tech/db" });
    expect(adapter.provider).toBe("postgresql");
    // { rows } is unwrapped to the array core iterates
    const rows = await (adapter.db as { execute: (q?: unknown) => Promise<unknown> }).execute();
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it("creates a FRESH pool per transaction and always ends it", async () => {
    const adapter = neonAdapter({ connectionString: "postgresql://user@x.neon.tech/db" });

    const result = await adapter.transaction(async (tx) => {
      expect((tx as { __tx: boolean }).__tx).toBe(true);
      return "done";
    });
    expect(result).toBe("done");
    expect(poolInstances).toHaveLength(1);
    expect(poolInstances[0]!.ended).toBe(true);

    await adapter.transaction(async () => null);
    expect(poolInstances).toHaveLength(2); // second call → second pool
    expect(poolInstances[1]!.ended).toBe(true);
  });

  it("ends the pool even when the transaction throws", async () => {
    const adapter = neonAdapter({ connectionString: "postgresql://user@x.neon.tech/db" });
    await expect(
      adapter.transaction(async () => {
        throw new Error("checkout failed");
      }),
    ).rejects.toThrow("checkout failed");
    expect(poolInstances).toHaveLength(1);
    expect(poolInstances[0]!.ended).toBe(true);
  });

  it("routes transaction pools through the Hyperdrive connection string when provided", async () => {
    const adapter = neonAdapter({
      connectionString: "postgresql://user@x.neon.tech/db",
      hyperdrive: { connectionString: "postgresql://hyperdrive-internal/db" },
    });
    await adapter.transaction(async () => null);
    expect(poolInstances[0]!.connectionString).toBe("postgresql://hyperdrive-internal/db");
  });

  it("splices transaction() onto db so kernel.database.db.transaction works too", async () => {
    const adapter = neonAdapter({ connectionString: "postgresql://user@x.neon.tech/db" });
    const db = adapter.db as unknown as { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    const out = await db.transaction(async (tx) => (tx as { __tx: boolean }).__tx);
    expect(out).toBe(true);
    expect(poolInstances).toHaveLength(1);
    expect(poolInstances[0]!.ended).toBe(true);
  });

  it("normalizeExecuteShape leaves array results untouched", async () => {
    const db = normalizeExecuteShape({
      execute: async () => [{ already: "array" }],
    } as never);
    expect(await (db as { execute: () => Promise<unknown> }).execute()).toEqual([{ already: "array" }]);
  });
});
