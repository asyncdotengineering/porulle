/**
 * Workers-grade Neon DatabaseAdapter for @porulle/core (issue #55).
 *
 * Two transports, picked by query type — the design proven in production by
 * porulle's first adopter (ordereka-fashion-pos, live on Cloudflare Workers):
 *
 *   1. Plain queries (select / insert / update / delete / raw execute) go
 *      through `@neondatabase/serverless` HTTP — stateless, no socket-reuse
 *      races across Workers isolates.
 *   2. `transaction()` creates a FRESH client per call. Direct Neon uses its
 *      WebSocket `Pool`; Hyperdrive uses Postgres.js over Workers TCP. Both
 *      clients are closed before the request completes. `drizzle-orm/neon-http`
 *      throws on `db.transaction()` ("No transactions support").
 *
 * Hyperdrive-aware: pass the binding (`{ hyperdrive: env.HYPERDRIVE }`) and
 * its TCP connection string is used by Postgres.js for transactions. A Neon
 * WebSocket client cannot speak to Hyperdrive's TCP endpoint. The HTTP driver
 * always speaks directly to Neon, so a direct `connectionString` is required.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, neon, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleHttp, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzleWs, type NeonDatabase } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DatabaseAdapter } from "@porulle/core";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket as unknown as typeof neonConfig.webSocketConstructor;
}

type HttpClient = NeonHttpDatabase<Record<string, unknown>>;
type WsClient = NeonDatabase<Record<string, unknown>>;
type PgClient = PostgresJsDatabase<Record<string, never>>;
type AnyDb = HttpClient | WsClient | PgClient;

export interface NeonAdapterOptions {
  /** Direct Neon connection string (postgresql://...neon.tech/...). */
  connectionString: string;
  /**
   * Optional Cloudflare Hyperdrive binding (or any object exposing
   * `connectionString`). When set, transactions use a fresh Postgres.js TCP
   * client through Hyperdrive; plain queries keep using Neon HTTP directly.
   */
  hyperdrive?: { connectionString: string } | undefined;
}

export type NeonDatabaseAdapter = DatabaseAdapter<HttpClient, unknown>;

type PostgresClient = ReturnType<typeof postgres>;

interface PooledScope {
  client: PostgresClient | undefined;
}

const pooledScope = new AsyncLocalStorage<PooledScope>();

/**
 * Run `fn` with ONE Hyperdrive client shared by every transaction it takes, closed when `fn`
 * settles either way.
 *
 * Why it exists. `runInHyperdriveClient` below used to open and end a Postgres.js client per
 * `transaction()` call. Measured on a deployed Worker on 2026-09-15: one import of 100 products
 * opened **63,355** of them, and a probe from inside that same Worker priced a client at 4 ms on
 * the medians and 7.7 ms on the means against a reused one, 88 ms on the first — on the order of
 * 250 to 500 seconds inside a 985-second import, paid for nothing.
 *
 * Why it is a scope and not a module-level client. A Worker may not reuse a socket across
 * invocations; an I/O object created in one request context throws when touched from another. So
 * the reuse is bounded by whatever the caller declares an invocation to be — a fetch, a queue
 * batch, a Workflow step — and the caller opens the scope. Nothing here is assumed to survive
 * past it.
 *
 * Why plain queries are NOT routed through it. The same probe measured Neon HTTP at 6.76 ms per
 * query against this client's 8.02 ms, with identical 7 ms medians. Moving them here would be
 * slower, and an HTTP query costs no connection at all.
 *
 * Hyperdrive's limits bound the scope: a query may run for at most 60 s and an idle connection is
 * dropped after 10 minutes. The client below raises Postgres.js's own `idle_timeout` from 5 s to
 * 30 s so a gap between two transactions in an import loop — about 2.6 s at the measured rate —
 * does not silently close and reopen the connection this function exists to hold, while staying
 * far inside Hyperdrive's own window.
 *
 * Nested calls join the enclosing scope rather than opening a second client, so a caller that
 * wraps both its handler and an inner unit of work gets one connection, not two.
 */
export async function withPooledTransactions<T>(fn: () => Promise<T>): Promise<T> {
  if (pooledScope.getStore()) return fn();

  const scope: PooledScope = { client: undefined };
  try {
    return await pooledScope.run(scope, fn);
  } finally {
    const client = scope.client;
    scope.client = undefined;
    // Both paths, deliberately: a failed invocation that leaks its connection is worse than one
    // that never pooled, because the leak is invisible until Hyperdrive runs out of them.
    if (client) await client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Normalizes `.execute()` to the postgres-js shape (array of rows). Core and
 * custom routes iterate `.execute()` results directly; the raw neon drivers
 * return `{ rows, command, rowCount }`, which breaks that contract.
 */
export function normalizeExecuteShape<T extends AnyDb>(db: T): T {
  const handler: ProxyHandler<T> = {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (prop === "execute" && typeof orig === "function") {
        return async (...args: unknown[]) => {
          const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (
            result &&
            typeof result === "object" &&
            "rows" in result &&
            Array.isArray((result as { rows: unknown[] }).rows)
          ) {
            return (result as { rows: unknown[] }).rows;
          }
          return result;
        };
      }
      return orig;
    },
  };
  return new Proxy(db, handler);
}

export function neonAdapter(options: NeonAdapterOptions): NeonDatabaseAdapter {
  const httpConnectionString = options.connectionString;

  const sql = neon(httpConnectionString);
  const httpDb = normalizeExecuteShape(drizzleHttp(sql) as HttpClient);

  const runInFreshNeonPool = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const pool = new Pool({ connectionString: options.connectionString });
    try {
      const wsDb = normalizeExecuteShape(drizzleWs(pool) as WsClient);
      return await wsDb.transaction(async (tx) => fn(normalizeExecuteShape(tx as WsClient)));
    } finally {
      // Best-effort: Pool.end() over WebSocket in Workers can be a no-op but
      // never throws into the transaction result.
      await pool.end().catch(() => {});
    }
  };

  const runInHyperdriveClient = async (
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    const runOn = async (client: PostgresClient) => {
      const pgDb = normalizeExecuteShape(drizzlePg(client) as PgClient);
      return await pgDb.transaction(async (tx) => fn(normalizeExecuteShape(tx as PgClient)));
    };

    // Inside a `withPooledTransactions` scope the client is created once and owned by the scope,
    // which closes it on both the success and the failure path. Closing it here instead would
    // defeat the reuse and pull the connection out from under the transactions still to come.
    const scope = pooledScope.getStore();
    if (scope) {
      scope.client ??= postgres(options.hyperdrive!.connectionString, {
        max: 1,
        prepare: false,
        connect_timeout: 10,
        // 30 s rather than the 5 s below: the gap between two transactions in an import loop is
        // about 2.6 s at the measured rate, close enough to 5 s that the connection this scope
        // exists to hold would close and reopen anyway. Far inside Hyperdrive's own 10-minute
        // idle timeout.
        idle_timeout: 30,
      });
      return await runOn(scope.client);
    }

    const client = postgres(options.hyperdrive!.connectionString, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 5,
    });
    try {
      return await runOn(client);
    } finally {
      await client.end({ timeout: 1 }).catch(() => {});
    }
  };

  const runTransaction = options.hyperdrive
    ? runInHyperdriveClient
    : runInFreshNeonPool;

  // Some core paths call `kernel.database.db.transaction(...)` directly —
  // splice the pool-backed transaction onto the HTTP client so both entry
  // points behave identically.
  const dbWithTx = new Proxy(httpDb, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return runTransaction;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as HttpClient;

  return {
    provider: "postgresql",
    db: dbWithTx,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return runTransaction(fn) as Promise<T>;
    },
  };
}
