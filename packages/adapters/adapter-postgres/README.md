# @porulle/adapter-postgres

The PostgreSQL `DatabaseAdapter` for `@porulle/core`. Drizzle on **node-postgres (`pg`)** — one package for Node and Cloudflare Workers (via Hyperdrive).

## Node — long-lived pool

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

## Cloudflare Workers — Hyperdrive

Cloudflare does not support Drizzle + Postgres.js over Hyperdrive; use this adapter's `pg` driver. Wrap each invocation (`fetch`, queue, `scheduled`) in `withDatabaseScope`:

```ts
import { hyperdriveAdapter, withDatabaseScope } from "@porulle/adapter-postgres";

const databaseAdapter = hyperdriveAdapter({
  connectionString: env.HYPERDRIVE.connectionString,
});

export default {
  async fetch(request, env) {
    return withDatabaseScope(async () => app.fetch(request, env));
  },
};
```

Do not call `pool.end()` on Workers — the runtime closes connections when the invocation ends.

## `pooled: true` — when to set it

If your `DATABASE_URL` points at a **transaction-mode pooler** (pgbouncer, pgcat, Fly Managed Postgres), set `pooled: true`. The pooler rejects per-session `SET` for timeouts — configure the role instead:

```sql
ALTER ROLE app SET statement_timeout = '30s';
ALTER ROLE app SET lock_timeout = '10s';
```

## What it does

- Opens a `pg.Pool` with the given options (`postgresAdapter`) or per-invocation pool (`hyperdriveAdapter` inside `withDatabaseScope`).
- Wraps it in Drizzle (`drizzle-orm/node-postgres`) and normalizes `db.execute()` via `@porulle/core`.
- Implements `DatabaseAdapter` — `transaction(fn)` honours nested transactions correctly.

## What it doesn't do

- No automatic migrations. Use `bunx drizzle-kit push` (dev) or `bunx drizzle-kit migrate` (prod) — see the CLI's `migrate` command.
- No connection retry on cold start. The kernel surfaces the error; redeploy or your platform's healthcheck handles it.

## See also

- [Deploy on Cloudflare Workers](../../../docs/deploy-cloudflare-workers.md)
- [Root README — Quick Start](../../../README.md#quick-start)
- [`SECURITY.md`](../../../SECURITY.md) — multi-tenant org-scoping is enforced at the repo layer; this adapter is the substrate
