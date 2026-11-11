# Deploy Porulle on Cloudflare Workers

Porulle runs on the Workers runtime, but the edge differs from Node in a few
ways. This recipe covers the four seams that matter: **lazy per-isolate boot**,
an **environment-aware database adapter**, **client-IP resolution**, and
**cron via `scheduled()`**. Each maps to a first-class config seam in
`@porulle/core` — you are not monkey-patching the framework.

---

## 1. Lazy, per-isolate boot (factory pattern)

`defineConfig({ databaseAdapter })` opens the DB when the config module loads —
but on Workers the per-isolate `env` (Hyperdrive bindings, secrets, R2) only
exists inside `fetch(request, env, ctx)`. So build the config from `env` and
memoize the server **per isolate**:

```ts
// commerce.config.ts — a factory, not a top-level config
import { defineConfig } from "@porulle/core";
import { hyperdriveAdapter } from "@porulle/adapter-postgres";

export function buildConfig(env: Env) {
  return defineConfig({
    storeName: "Acme",
    databaseAdapter: hyperdriveAdapter({
      connectionString: env.HYPERDRIVE.connectionString,
    }),
    storage: r2StorageAdapter({ bucket: env.MEDIA_BUCKET, bucketName: "media" }),
    runtime: { getClientIp: (c) => c.req.header("cf-connecting-ip") ?? "unknown" }, // §3
  });
}
```

```ts
// worker.ts — memoize the server once per isolate; one DB scope per invocation
import { createServer } from "@porulle/core";
import { withDatabaseScope } from "@porulle/adapter-postgres";
import { buildConfig } from "./commerce.config";

let cached: Promise<Awaited<ReturnType<typeof createServer>>> | null = null;
function getServer(env: Env) {
  if (!cached) {
    // Better Auth reads some secrets from process.env — bridge them once.
    globalThis.process ??= { env: {} } as never;
    process.env.BETTER_AUTH_SECRET = env.BETTER_AUTH_SECRET;
    cached = createServer(await buildConfig(env));
  }
  return cached;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return withDatabaseScope(async () => {
      const { app } = await getServer(env);
      return app.fetch(request, env, ctx);
    });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const server = await getServer(env);
    ctx.waitUntil(withDatabaseScope(() => server.runJobs()));
  },
};
```

The cache key is the isolate lifetime: a new isolate rebuilds; a warm isolate
reuses. Rebuild on deploy is automatic (new isolates).

## 2. Database adapter

**Use `@porulle/adapter-postgres` with `hyperdriveAdapter` and `withDatabaseScope`. Do not hand-roll this one.**

Cloudflare documents Drizzle on Postgres.js over Hyperdrive as **not supported** — use **node-postgres (`pg`)** with `drizzle-orm/node-postgres` instead. Porulle ships that stack in one adapter:

```ts
import { hyperdriveAdapter, withDatabaseScope } from "@porulle/adapter-postgres";

const databaseAdapter = hyperdriveAdapter({
  connectionString: env.HYPERDRIVE.connectionString,
});
```

### Why not a hand-rolled adapter

Two constraints collide on Workers:

1. **Real transactions** — checkout, staff revocation, POS returns, and inventory
   paths need `db.transaction()` with rollback and row locks. A no-op
   `transaction: (fn) => fn(db)` type-checks and fails only under concurrency.

2. **Connection lifecycle** — a module-scope `pg` client cannot be reused across
   invocations (Workers forbid cross-request socket reuse). Opening one client per
   SQL statement is correct but slow; opening one client with `max: 1` **hangs**
   when an outer query runs while a transaction holds the only connection (how
   Porulle's checkout validation hooks behave).

`hyperdriveAdapter` opens **one `pg.Pool` with `max: 5` per invocation** inside
`withDatabaseScope`, lazily on first use. Plain queries and transactions share
that pool. Do **not** call `pool.end()` — Cloudflare tears down connections when
the invocation ends; `ctx.waitUntil` work after the response still needs the pool.

| Path | What breaks without real transactions |
| --- | --- |
| `PATCH` / `DELETE /api/admin/staff/:id` | Last-owner invariant under concurrent revocations |
| `POST /api/pos/returns` | Refund ledger and payout no longer atomic |
| `POST /api/checkout` | Phase-1 validation stops rolling back as a unit |
| Inventory adjust, jobs reaper | Row locks stop holding for read-modify-write |

### Local `wrangler dev`

Hyperdrive's local binding points at localhost. Use the binding's
`connectionString` (or `DATABASE_URL` when the binding is absent) and the same
`hyperdriveAdapter` + `withDatabaseScope` wrapper — `pg` runs real transactions
against local Postgres. Require `nodejs_compat` and `pg` ≥ 8.16.3.

### Node servers

Long-lived processes use `postgresAdapter({ connectionString, pool })` — one
process-wide pool, no `withDatabaseScope`.

### Lock timeouts

`postgresAdapter` sets `lock_timeout` to 10s by default on direct connections.
Hyperdrive/Workers paths inherit whatever the database role sets:

```sql
ALTER ROLE app SET lock_timeout = '10s';
```

Transaction-mode poolers reject `lock_timeout` as a startup parameter, so it
belongs on the role.

## 3. Client-IP resolution (rate limiting)

`c.req.raw.socket.remoteAddress` is always undefined on Workers, which would
collapse every client onto one rate-limit key. Inject the platform header:

```ts
defineConfig({
  runtime: {
    getClientIp: (c) => c.req.header("cf-connecting-ip") ?? "unknown",
    // Vercel Edge: c.req.header("x-real-ip"); Fly: c.req.header("fly-client-ip")
  },
});
```

## 4. Cron via `scheduled()`

In-process `setInterval` can't outlive a request on Workers. Drive the job queue
from a cron trigger calling `server.runJobs()` (one runner tick), wrapped in
`withDatabaseScope` like `fetch`:

```toml
# wrangler.toml
[triggers]
crons = ["*/5 * * * *"]

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "acme-media"
```

## 5. Storage

Use [`@porulle/adapter-r2`](../packages/adapters/adapter-r2/README.md) for media
on Workers (the R2 binding is a native object — no AWS SDK). For a catalog-only
deployment with no media, omit `storage` entirely: `defineConfig` defaults to a
no-op adapter and `/api/media/upload` returns `501 storage_not_supported`.
