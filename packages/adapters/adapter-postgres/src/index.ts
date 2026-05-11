import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { DatabaseAdapter } from "@porulle/core";

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
   * NOTE: this is sent as a libpq startup parameter, which transaction-mode
   * poolers (pgbouncer, pgcat, Fly Managed Postgres' pooler) reject as an
   * "unsupported startup parameter". When `pooled: true` is set we skip the
   * startup parameter — set the timeouts on the DB role instead, e.g.
   * `ALTER ROLE app SET statement_timeout = '30s';`
   */
  statementTimeoutMs?: number;
  /**
   * Maximum time (ms) to wait for a row lock. Default: 10000. Same pooler
   * caveat as `statementTimeoutMs` — skipped when `pooled: true`.
   */
  lockTimeoutMs?: number;
  /**
   * Set to true when connecting through a transaction-mode pooler
   * (pgbouncer, pgcat, Fly Managed Postgres). Skips startup parameters that
   * poolers reject. Defaults to false (assumes a direct PG connection).
   */
  pooled?: boolean;
}

export interface PostgresAdapterOptions {
  connectionString: string;
  /** Connection pool tuning. Defaults are production-reasonable. */
  pool?: PostgresPoolOptions;
}

export type PostgresDrizzleClient = ReturnType<typeof drizzle>;
export type PostgresDatabaseAdapter = DatabaseAdapter<PostgresDrizzleClient, unknown>;

export function postgresAdapter(options: PostgresAdapterOptions): PostgresDatabaseAdapter {
  const pool = options.pool ?? {};

  const statementTimeout = pool.statementTimeoutMs ?? 30_000;
  const lockTimeout = pool.lockTimeoutMs ?? 10_000;
  const pooled = pool.pooled ?? false;

  const client = postgres(options.connectionString, {
    max: pool.max ?? 20,
    idle_timeout: pool.idleTimeout ?? 30,
    connect_timeout: pool.connectTimeout ?? 10,
    prepare: false,
    // Direct PG connections accept these as startup parameters. Pooled
    // connections reject them — set timeouts via `ALTER ROLE ... SET` instead.
    ...(pooled
      ? {}
      : {
          connection: {
            statement_timeout: String(statementTimeout),
            lock_timeout: String(lockTimeout),
          } as Record<string, string>,
        }),
  });
  const db = drizzle(client);

  return {
    provider: "postgresql",
    db,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => fn(tx));
    },
  };
}
