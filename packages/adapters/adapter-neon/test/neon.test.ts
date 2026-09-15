import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #55 — no first-party Neon/Workers adapter existed; integrators
// hand-rolled hybrid adapters (ordereka's hyperdrive-adapter.ts). These tests
// verify the adapter's orchestration: HTTP driver for plain queries, a FRESH
// request-scoped transaction client, Postgres.js routing for Hyperdrive, and
// postgres-js-shaped `.execute()`.

const poolInstances: Array<{ connectionString: string; ended: boolean }> = [];
const postgresInstances: Array<{
  connectionString: string;
  options: Record<string, unknown>;
  ended: boolean;
}> = [];

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

vi.mock("postgres", () => ({
  default: vi.fn((connectionString: string, options: Record<string, unknown>) => {
    const client = {
      connectionString,
      options,
      ended: false,
      async end() {
        client.ended = true;
      },
    };
    postgresInstances.push(client);
    return client;
  }),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn((client: unknown) => ({
    __driver: "postgres-js",
    __client: client,
    execute: vi.fn(async () => [{ tx: 1 }]),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ __tx: true, execute: async () => [{ inTx: 1 }] }),
    ),
  })),
}));

import { neonAdapter, normalizeExecuteShape, withPooledTransactions } from "../src/index.js";

beforeEach(() => {
  poolInstances.length = 0;
  postgresInstances.length = 0;
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

  it("routes Hyperdrive transactions through a fresh Postgres.js client", async () => {
    const adapter = neonAdapter({
      connectionString: "postgresql://user@x.neon.tech/db",
      hyperdrive: { connectionString: "postgresql://hyperdrive-internal/db" },
    });
    await adapter.transaction(async () => null);
    expect(poolInstances).toHaveLength(0);
    expect(postgresInstances).toHaveLength(1);
    expect(postgresInstances[0]!.connectionString).toBe("postgresql://hyperdrive-internal/db");
    expect(postgresInstances[0]!.options).toMatchObject({ max: 1, prepare: false });
    expect(postgresInstances[0]!.ended).toBe(true);
  });

  it("ends the Hyperdrive client when the transaction throws", async () => {
    const adapter = neonAdapter({
      connectionString: "postgresql://user@x.neon.tech/db",
      hyperdrive: { connectionString: "postgresql://hyperdrive-internal/db" },
    });
    await expect(
      adapter.transaction(async () => {
        throw new Error("checkout failed");
      }),
    ).rejects.toThrow("checkout failed");
    expect(postgresInstances[0]!.ended).toBe(true);
  });

  it("splices transaction() onto db so kernel.database.db.transaction works too", async () => {
    const adapter = neonAdapter({ connectionString: "postgresql://user@x.neon.tech/db" });
    const db = adapter.db as unknown as { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    const out = await db.transaction(async (tx) => (tx as { __tx: boolean }).__tx);
    expect(out).toBe(true);
    expect(poolInstances).toHaveLength(1);
    expect(poolInstances[0]!.ended).toBe(true);
  });

  /**
   * One import of 100 products on the deployed Worker opened and closed 63,355 Postgres.js clients
   * — one per transaction — while a probe from inside that Worker priced a client at 4 ms on the
   * medians and 7.7 ms on the means against a reused one, and 88 ms on the first. That is on the
   * order of 250-500 seconds inside a 985-second import, paid for nothing: the connection is
   * reusable within a single invocation, which is as far as a Worker may hold a socket at all.
   *
   * Plain queries deliberately do NOT move. The same probe measured Neon HTTP at 6.76 ms per query
   * against the pooled client's 8.02 ms, so routing them through this client would be slower.
   */
  it("reuses ONE Hyperdrive client for every transaction inside a pooled scope", async () => {
    const adapter = neonAdapter({
      connectionString: "postgresql://user@x.neon.tech/db",
      hyperdrive: { connectionString: "postgresql://hyperdrive-internal/db" },
    });

    await withPooledTransactions(async () => {
      await adapter.transaction(async () => null);
      await adapter.transaction(async () => null);
      await adapter.transaction(async () => null);
      expect(
        postgresInstances,
        "three transactions in one scope must share one client, not open three",
      ).toHaveLength(1);
      expect(
        postgresInstances[0]!.ended,
        "the shared client must stay OPEN while the scope is still running",
      ).toBe(false);
    });

    expect(postgresInstances).toHaveLength(1);
    expect(postgresInstances[0]!.ended, "the scope must end the client it opened").toBe(true);
  });

  it("ends the pooled client when the scope body throws", async () => {
    const adapter = neonAdapter({
      connectionString: "postgresql://user@x.neon.tech/db",
      hyperdrive: { connectionString: "postgresql://hyperdrive-internal/db" },
    });

    await expect(
      withPooledTransactions(async () => {
        await adapter.transaction(async () => null);
        throw new Error("invocation failed");
      }),
    ).rejects.toThrow("invocation failed");

    expect(postgresInstances).toHaveLength(1);
    expect(
      postgresInstances[0]!.ended,
      "a failed invocation must still close its connection, or the leak is the failure path",
    ).toBe(true);
  });

  it("opens no client for a scope that takes no transaction", async () => {
    neonAdapter({
      connectionString: "postgresql://user@x.neon.tech/db",
      hyperdrive: { connectionString: "postgresql://hyperdrive-internal/db" },
    });
    await withPooledTransactions(async () => "nothing to do");
    expect(postgresInstances).toHaveLength(0);
  });

  it("joins an enclosing scope rather than opening a second client", async () => {
    const adapter = neonAdapter({
      connectionString: "postgresql://user@x.neon.tech/db",
      hyperdrive: { connectionString: "postgresql://hyperdrive-internal/db" },
    });

    await withPooledTransactions(async () => {
      await adapter.transaction(async () => null);
      await withPooledTransactions(async () => {
        await adapter.transaction(async () => null);
      });
      expect(
        postgresInstances[0]!.ended,
        "an inner scope must not close the outer scope's client out from under it",
      ).toBe(false);
    });
    expect(postgresInstances).toHaveLength(1);
    expect(postgresInstances[0]!.ended).toBe(true);
  });

  it("still opens a client per transaction with no scope, so nothing changes for a caller that does not opt in", async () => {
    const adapter = neonAdapter({
      connectionString: "postgresql://user@x.neon.tech/db",
      hyperdrive: { connectionString: "postgresql://hyperdrive-internal/db" },
    });
    await adapter.transaction(async () => null);
    await adapter.transaction(async () => null);
    expect(postgresInstances).toHaveLength(2);
    expect(postgresInstances.every((client) => client.ended)).toBe(true);
  });

  it("normalizeExecuteShape leaves array results untouched", async () => {
    const db = normalizeExecuteShape({
      execute: async () => [{ already: "array" }],
    } as never);
    expect(await (db as { execute: () => Promise<unknown> }).execute()).toEqual([{ already: "array" }]);
  });
});
