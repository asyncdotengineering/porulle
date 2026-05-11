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
}

export interface DatabaseConnectionFactoryInput {
  adapter: DatabaseAdapter;
}

export function createDatabaseConnection(input: DatabaseConnectionFactoryInput): DatabaseAdapter {
  return input.adapter;
}
