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

  const runInFreshHyperdriveClient = async (
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    const client = postgres(options.hyperdrive!.connectionString, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 5,
    });
    try {
      const pgDb = normalizeExecuteShape(drizzlePg(client) as PgClient);
      return await pgDb.transaction(async (tx) => fn(normalizeExecuteShape(tx as PgClient)));
    } finally {
      await client.end({ timeout: 1 }).catch(() => {});
    }
  };

  const runTransaction = options.hyperdrive
    ? runInFreshHyperdriveClient
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
