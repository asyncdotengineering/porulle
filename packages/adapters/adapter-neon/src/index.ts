/**
 * Workers-grade Neon DatabaseAdapter for @porulle/core (issue #55).
 *
 * Two transports, picked by query type — the design proven in production by
 * porulle's first adopter (ordereka-fashion-pos, live on Cloudflare Workers):
 *
 *   1. Plain queries (select / insert / update / delete / raw execute) go
 *      through `@neondatabase/serverless` HTTP — stateless, no socket-reuse
 *      races across Workers isolates.
 *   2. `transaction()` creates a FRESH WebSocket `Pool` per call, runs the
 *      transaction, then ends the pool. `drizzle-orm/neon-http` throws on
 *      `db.transaction()` ("No transactions support"), and isolate-shared
 *      WebSocket pools flake (~30% observed) when reused across requests —
 *      a short-lived pool per transaction gives atomicity without the flake.
 *
 * Hyperdrive-aware: pass the binding (`{ hyperdrive: env.HYPERDRIVE }`) and
 * its connection string is used for the per-transaction pools, keeping pool
 * setup on Cloudflare's fast path. The HTTP driver always speaks directly to
 * Neon, so a direct `connectionString` is still required alongside it.
 */
import { Pool, neon, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleHttp, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzleWs, type NeonDatabase } from "drizzle-orm/neon-serverless";
import type { DatabaseAdapter } from "@porulle/core";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket as unknown as typeof neonConfig.webSocketConstructor;
}

type HttpClient = NeonHttpDatabase<Record<string, unknown>>;
type WsClient = NeonDatabase<Record<string, unknown>>;
type AnyDb = HttpClient | WsClient;

export interface NeonAdapterOptions {
  /** Direct Neon connection string (postgresql://...neon.tech/...). */
  connectionString: string;
  /**
   * Optional Cloudflare Hyperdrive binding (or any object exposing
   * `connectionString`). When set, per-transaction pools connect through it;
   * plain queries keep using the Neon HTTP driver against `connectionString`.
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
  const poolConnectionString = options.hyperdrive?.connectionString ?? options.connectionString;

  const sql = neon(httpConnectionString);
  const httpDb = normalizeExecuteShape(drizzleHttp(sql) as HttpClient);

  const runInFreshPool = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const pool = new Pool({ connectionString: poolConnectionString });
    try {
      const wsDb = normalizeExecuteShape(drizzleWs(pool) as WsClient);
      return await wsDb.transaction(async (tx) => fn(normalizeExecuteShape(tx as WsClient)));
    } finally {
      // Best-effort: Pool.end() over WebSocket in Workers can be a no-op but
      // never throws into the transaction result.
      await pool.end().catch(() => {});
    }
  };

  // Some core paths call `kernel.database.db.transaction(...)` directly —
  // splice the pool-backed transaction onto the HTTP client so both entry
  // points behave identically.
  const dbWithTx = new Proxy(httpDb, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return runInFreshPool;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as HttpClient;

  return {
    provider: "postgresql",
    db: dbWithTx,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return runInFreshPool(fn) as Promise<T>;
    },
  };
}
