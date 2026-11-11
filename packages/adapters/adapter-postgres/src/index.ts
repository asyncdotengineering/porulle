import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { normalizeExecuteShape, type DatabaseAdapter } from "@porulle/core";

export interface PostgresPoolOptions {
  /** Maximum number of connections in the pool. Default: 20. */
  max?: number;
  /** Seconds a connection can idle before being closed. Default: 30. */
  idleTimeout?: number;
  /** Seconds to wait for a connection before throwing. Default: 10. */
  connectTimeout?: number;
  /**
   * Maximum time (ms) any single SQL statement can run before PostgreSQL kills it.
   * Default: 30000. Set to 0 to disable.
   *
   * NOTE: sent as a startup `options` parameter (`-c statement_timeout=…`) on direct
   * connections. Transaction-mode poolers (pgbouncer, pgcat, Fly Managed Postgres'
   * pooler) reject startup parameters — when `pooled: true` is set it is not sent;
   * configure the DB role instead, e.g. `ALTER ROLE app SET statement_timeout = '30s';`
   */
  statementTimeoutMs?: number;
  /**
   * Maximum time (ms) to wait for a row lock. Default: 10000. Same pooler
   * caveat as `statementTimeoutMs` — skipped when `pooled: true`.
   */
  lockTimeoutMs?: number;
  /**
   * Set to true when connecting through a transaction-mode pooler
   * (pgbouncer, pgcat, Fly Managed Postgres). Skips session SET commands that
   * poolers reject. Defaults to false (assumes a direct PG connection).
   */
  pooled?: boolean;
}

export interface PostgresAdapterOptions {
  connectionString: string;
  /** Connection pool tuning. Defaults are production-reasonable. */
  pool?: PostgresPoolOptions;
}

export type PostgresDrizzleClient = NodePgDatabase<Record<string, unknown>>;
export type PostgresDatabaseAdapter = DatabaseAdapter<PostgresDrizzleClient, unknown>;

function attachPoolErrorHandler(pool: Pool): void {
  pool.on("error", (err: Error) => {
    console.error("[@porulle/adapter-postgres] idle pool client error (continuing):", err.message);
  });
}

function connectionStringWithStartupTimeouts(
  connectionString: string,
  statementTimeoutMs: number,
  lockTimeoutMs: number,
): string {
  try {
    const url = new URL(connectionString);
    const extra = `-c statement_timeout=${statementTimeoutMs} -c lock_timeout=${lockTimeoutMs}`;
    const existing = url.searchParams.get("options");
    url.searchParams.set("options", existing ? `${existing} ${extra}` : extra);
    return url.toString();
  } catch {
    const sep = connectionString.includes("?") ? "&" : "?";
    const options = encodeURIComponent(
      `-c statement_timeout=${statementTimeoutMs} -c lock_timeout=${lockTimeoutMs}`,
    );
    return `${connectionString}${sep}options=${options}`;
  }
}

function createPgPool(connectionString: string, poolOpts: PostgresPoolOptions): Pool {
  const statementTimeout = poolOpts.statementTimeoutMs ?? 30_000;
  const lockTimeout = poolOpts.lockTimeoutMs ?? 10_000;
  const pooled = poolOpts.pooled ?? false;

  const pool = new Pool({
    connectionString: pooled
      ? connectionString
      : connectionStringWithStartupTimeouts(connectionString, statementTimeout, lockTimeout),
    max: poolOpts.max ?? 20,
    idleTimeoutMillis: (poolOpts.idleTimeout ?? 30) * 1000,
    connectionTimeoutMillis: (poolOpts.connectTimeout ?? 10) * 1000,
  });
  attachPoolErrorHandler(pool);

  return pool;
}

function drizzleFromPool(pool: Pool): PostgresDrizzleClient {
  return normalizeExecuteShape(drizzle(pool));
}

export function postgresAdapter(options: PostgresAdapterOptions): PostgresDatabaseAdapter {
  const poolOpts = options.pool ?? {};
  const pool = createPgPool(options.connectionString, poolOpts);
  const db = drizzleFromPool(pool);

  return {
    provider: "postgresql",
    db,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => fn(tx));
    },
  };
}

const databaseScope = new AsyncLocalStorage<Map<string, PostgresDrizzleClient>>();

export class DatabaseScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseScopeError";
  }
}

/**
 * Opens the invocation's database scope. Nested calls join the enclosing scope.
 * Required around Worker entrypoints that use {@link hyperdriveAdapter}.
 */
export function withDatabaseScope<T>(fn: () => Promise<T>): Promise<T> {
  if (databaseScope.getStore()) return fn();
  return databaseScope.run(new Map(), fn);
}

function scopeClient(connectionString: string): PostgresDrizzleClient {
  const store = databaseScope.getStore();
  if (!store) {
    throw new DatabaseScopeError(
      "hyperdriveAdapter database handle used outside withDatabaseScope — wrap the Worker entrypoint (fetch, queue, scheduled) in withDatabaseScope()",
    );
  }
  const existing = store.get(connectionString);
  if (existing) return existing;

  // max: 5 — measured on Workers + Hyperdrive: max=1 hangs when an outer query
  // runs while a transaction holds the only connection (checkout validation hooks).
  // Do not call pool.end(); Cloudflare tears down connections when the invocation ends.
  const pool = new Pool({ connectionString, max: 5 });
  attachPoolErrorHandler(pool);
  const db = drizzleFromPool(pool);
  store.set(connectionString, db);
  return db;
}

function createScopedDbHandle(connectionString: string): PostgresDrizzleClient {
  // The target is a real drizzle instance that is never queried, so code that inspects the handle
  // rather than calling it sees a genuine database: `"select" in db`, prototype walks such as a
  // vendor-scoping guard's search for unclassified data methods, `instanceof`. Over an empty object
  // those checks see nothing, and a guard built on them fails open. Constructing a Pool opens no
  // socket. Every property READ resolves the current invocation's own instance.
  const shape = drizzleFromPool(new Pool({ connectionString, max: 1 }));
  return new Proxy(shape, {
    get(_target, prop) {
      const current = scopeClient(connectionString);
      const value: unknown = Reflect.get(current, prop);
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
}

export function hyperdriveAdapter(options: { connectionString: string }): PostgresDatabaseAdapter {
  const db = createScopedDbHandle(options.connectionString);

  return {
    provider: "postgresql",
    db,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return scopeClient(options.connectionString).transaction(async (tx) => fn(tx));
    },
  };
}
