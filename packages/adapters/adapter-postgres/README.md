# @porulle/adapter-postgres

The PostgreSQL `DatabaseAdapter` for `@porulle/core`. Drizzle on `postgres-js`. The only database backend Porulle ships today.

## Usage

```ts
import { defineConfig } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";

export default defineConfig({
  databaseAdapter: postgresAdapter({
    connectionString: process.env.DATABASE_URL!,
    pool: {
      max: 20,
      idleTimeout: 30,
      connectTimeout: 10,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 10_000,
      pooled: false,        // set true behind pgbouncer / pgcat / Fly MPG
    },
  }),
  // …
});
```

## `pooled: true` — when to set it

If your `DATABASE_URL` points at a **transaction-mode pooler** (pgbouncer, pgcat, Fly Managed Postgres), set `pooled: true`. The pooler rejects libpq startup parameters like `statement_timeout` — when `pooled` is on, the adapter skips them. Set the timeouts on the DB role instead:

```sql
ALTER ROLE app SET statement_timeout = '30s';
ALTER ROLE app SET lock_timeout = '10s';
```

Direct PostgreSQL connections (no pooler) leave `pooled: false` (the default) so the adapter sets the timeouts per-session.

## What it does

- Opens a `postgres-js` connection pool with the given options.
- Wraps it in Drizzle (`drizzle-orm/postgres-js`).
- Implements `DatabaseAdapter` from `@porulle/core` — `transaction(fn)` honours nested transactions correctly.

## What it doesn't do

- No automatic migrations. Use `bunx drizzle-kit push` (dev) or `bunx drizzle-kit migrate` (prod) — see the CLI's `migrate` command.
- No connection retry on cold start. The kernel surfaces the error; redeploy or your platform's healthcheck handles it.

## See also

- [Root README — Quick Start](../../../README.md#quick-start)
- [`SECURITY.md`](../../../SECURITY.md) — multi-tenant org-scoping is enforced at the repo layer; this adapter is the substrate
