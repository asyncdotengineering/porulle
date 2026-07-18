/**
 * Database adapter interface for the commerce engine.
 *
 * Generic defaults to `unknown` so that any driver-specific adapter
 * (postgres-js, PGlite, etc.) can implement it without type conflicts.
 * Internal code narrows to `PluginDb` at the consumption site — see
 * PluginContext in manifest.ts and createHookContext.
 */
export interface DatabaseAdapter<TDatabase = unknown, TTransaction = unknown> {
  provider: string;
  db: TDatabase;
  transaction<T>(fn: (tx: TTransaction) => Promise<T>): Promise<T>;
  /**
   * Zero-migration adapters (e.g. PGlite) set this so the runtime pushes any
   * plugin-declared tables (`config.customSchemas`) at boot. Plugin schemas
   * only exist after plugins run in `defineConfig` — i.e. after this adapter was
   * constructed — so the adapter cannot create them itself. Omit/false when the
   * consumer manages migrations (e.g. production Postgres via drizzle-kit).
   */
  autoMigrate?: boolean;
}

export interface DatabaseConnectionFactoryInput {
  adapter: DatabaseAdapter;
}

/**
 * Marker used to retrieve the raw, un-normalized driver from a wrapped db.
 * Tools that drive the driver directly (drizzle-kit's `pushSchema`, which
 * relies on the native `db.execute()` shape) must unwrap first via {@link unwrapDb}.
 */
const RAW_DB = Symbol.for("porulle.rawDb");

/**
 * Return the raw driver behind a db normalized by {@link normalizeExecuteShape}.
 * If `db` isn't wrapped, it is returned unchanged. Use before handing a db to
 * drizzle-kit (`pushSchema`/introspection), which needs the native result shape.
 */
export function unwrapDb<T>(db: T): T {
  if (db != null && typeof db === "object") {
    const raw = (db as Record<symbol, unknown>)[RAW_DB];
    if (raw) return raw as T;
  }
  return db;
}

/**
 * Normalize `db.execute()` so it returns a row array regardless of the
 * underlying driver. postgres-js returns the rows directly, while neon-http
 * and node-postgres (and PGlite) return `{ rows, command, rowCount }`.
 * Without this, raw-SQL code that destructures the result as an array breaks
 * on the `{ rows }` drivers. We intercept only `execute`; every other method
 * is bound to the real driver instance so its internals are untouched.
 */
function normalizeExecuteShape<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === RAW_DB) return target;
      if (prop === "execute") {
        const orig = Reflect.get(target, prop, receiver);
        if (typeof orig !== "function") return orig;
        return async (...args: unknown[]) => {
          const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (
            result != null &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            Array.isArray((result as { rows?: unknown }).rows)
          ) {
            return (result as { rows: unknown[] }).rows;
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      // Bind methods to the real instance so drizzle's internals (incl. any
      // private fields) are never accessed through the proxy.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createDatabaseConnection(input: DatabaseConnectionFactoryInput): DatabaseAdapter {
  const adapter = input.adapter;
  return {
    provider: adapter.provider,
    db: normalizeExecuteShape(adapter.db as object),
    transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return adapter.transaction((tx) => fn(normalizeExecuteShape(tx as object)));
    },
  };
}
