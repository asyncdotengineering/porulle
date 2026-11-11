---
"@porulle/adapter-postgres": minor
---

Breaking: `@porulle/adapter-neon` is removed; `@porulle/adapter-postgres` now runs on node-postgres (`pg`) and adds `hyperdriveAdapter` + `withDatabaseScope` for Cloudflare Workers.

Cloudflare documents Drizzle with Postgres.js over Hyperdrive as unsupported — switch to `pg` + `drizzle-orm/node-postgres` (see [their Drizzle example](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)).

**Node (unchanged call site, new driver):**

```ts
import { postgresAdapter } from "@porulle/adapter-postgres";

databaseAdapter: postgresAdapter({ connectionString: process.env.DATABASE_URL! }),
```

**Workers (before → after):**

```ts
// before
import { neonAdapter, withPooledTransactions } from "@porulle/adapter-neon";
databaseAdapter: neonAdapter({ connectionString: env.DATABASE_URL, hyperdrive: env.HYPERDRIVE });
await withPooledTransactions(() => app.fetch(request, env));

// after
import { hyperdriveAdapter, withDatabaseScope } from "@porulle/adapter-postgres";
databaseAdapter: hyperdriveAdapter({ connectionString: env.HYPERDRIVE.connectionString });
await withDatabaseScope(() => app.fetch(request, env));
```

Use `pg` ≥ 8.16.3 and enable `nodejs_compat`. Do not call `pool.end()` in Workers.
