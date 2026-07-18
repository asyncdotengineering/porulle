# @porulle/adapter-pglite

A **zero-infrastructure** `DatabaseAdapter` for [`@porulle/core`](https://porulle.asyncdot.com), backed by [PGlite](https://pglite.dev) — real PostgreSQL compiled to WASM, running **in-process**.

No database server to install. No connection string. No migration command. Construct it and the store runs — locally, in CI, in a demo, anywhere Node runs.

```ts
// commerce.config.ts
import { defineConfig } from "@porulle/core";
import { pgliteAdapter } from "@porulle/adapter-pglite";

export default defineConfig({
  databaseAdapter: await pgliteAdapter({ path: "./.data/pgdata" }),
  // ...rest of your config
});
```

That's it — `pnpm dev` and the REST API is live on a real Postgres.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | `string` | in-memory | Persist the DB to disk (e.g. `"./.data/pgdata"`). Omit for an ephemeral instance discarded on exit. |
| `migrate` | `boolean` | `true` | Push the core schema on init (create tables if missing) — no separate migration step. |
| `seedDefaultOrg` | `boolean` | `true` | Insert the default organization row so single-tenant / B2C stores work immediately. |

## When to use it

- **Local dev & demos** — the fastest path from `install` to a running store.
- **Tests & CI** — real Postgres semantics without provisioning a database.
- **Prototypes** — ship the 80% before you own any infrastructure.

## Going to production

PGlite is single-connection and in-process — perfect for dev, not for production scale. When you're ready, swap one line to [`@porulle/adapter-postgres`](https://porulle.asyncdot.com) — the same `DatabaseAdapter` contract, backed by a real Postgres server:

```ts
import { postgresAdapter } from "@porulle/adapter-postgres";

databaseAdapter: postgresAdapter({ connectionString: process.env.DATABASE_URL! }),
```

Your data model, queries, and code are unchanged — it's the same PostgreSQL.
