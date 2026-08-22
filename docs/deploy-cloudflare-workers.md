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

export function buildConfig(env: Env) {
  return defineConfig({
    storeName: "Acme",
    databaseAdapter: workersDbAdapter(env.HYPERDRIVE.connectionString), // §2
    storage: r2StorageAdapter({ bucket: env.MEDIA_BUCKET, bucketName: "media" }),
    runtime: { getClientIp: (c) => c.req.header("cf-connecting-ip") ?? "unknown" }, // §3
  });
}
```

```ts
// worker.ts — memoize the server once per isolate
import { createServer } from "@porulle/core";
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
    const { app } = await getServer(env);
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const server = await getServer(env);
    ctx.waitUntil(server.runJobs()); // §4
  },
};
```

The cache key is the isolate lifetime: a new isolate rebuilds; a warm isolate
reuses. Rebuild on deploy is automatic (new isolates).

## 2. Database adapter

**Use `@porulle/adapter-neon`. Do not hand-roll this one.**

```ts
import { neonAdapter } from "@porulle/adapter-neon";

const databaseAdapter = neonAdapter({
  connectionString: env.DATABASE_URL,
  // Optional. When present, transactions run over Hyperdrive's TCP endpoint
  // instead of a Neon WebSocket pool.
  hyperdrive: env.HYPERDRIVE,
});
```

### Why not a hand-rolled adapter

Two transports are needed, and picking one is not enough.

Plain reads and writes want Neon's **HTTP** driver
(`@neondatabase/serverless` + `drizzle-orm/neon-http`) — stateless, with no
socket-reuse races across Workers isolates. But `drizzle-orm/neon-http` throws
on `db.transaction()` with *"No transactions support"*, because HTTP has no
session to hold one open.

The tempting workaround is to satisfy the `DatabaseAdapter` interface like this:

```ts
// ✘ WRONG — this is not a transaction
return { provider: "postgresql", db, transaction: (fn) => fn(db) };
```

That type-checks and boots, and every statement inside it runs as its own
auto-committed HTTP request. Nothing rolls back, and a `SELECT … FOR UPDATE`
releases its lock the instant the statement returns. **Failures are silent and
only appear under concurrency**, which is the worst possible shape for a bug.

Paths that lose their guarantee with a no-op transaction:

| Path | What breaks |
| --- | --- |
| `PATCH` / `DELETE /api/admin/staff/:id` | The last-owner invariant. Concurrent revocations are no longer serialised. |
| `POST /api/pos/returns` | The refund ledger move and the payout stop being atomic — a return can strand between them. |
| `POST /api/checkout` | Phase-1 validation stops rolling back as a unit. |
| Inventory adjust, jobs reaper | Row locks stop holding for the read-modify-write. |

`neonAdapter` handles it: plain queries go over HTTP, and `transaction()` opens
a **fresh** client per call — a Neon WebSocket `Pool`, or Postgres.js over
Workers TCP when a Hyperdrive binding is supplied — closing it before the
request completes. The pool-backed `transaction` is also spliced onto the HTTP
client, so `kernel.database.db.transaction(...)` and
`kernel.database.transaction(...)` behave identically.

A transaction therefore costs one connection setup. Every path in the table
above is an infrequent write, so that is the right trade.

### Local `wrangler dev`

neon-http fails under miniflare, and Hyperdrive's local binding points at
localhost. Branch on the connection string and use Postgres.js locally — with a
**real** transaction:

```ts
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { neonAdapter } from "@porulle/adapter-neon";
import type { DatabaseAdapter } from "@porulle/core";
import * as schema from "@porulle/core/schema";

const isLocalDev = (cs: string) => /(?:localhost|127\.0\.0\.1|\[::1\])/.test(cs);

export function workersDbAdapter(
  connectionString: string,
  hyperdrive?: { connectionString: string },
): DatabaseAdapter {
  if (isLocalDev(connectionString)) {
    const sql = postgres(connectionString, { prepare: false, max: 5 });
    return {
      provider: "postgresql",
      db: drizzlePg(sql, { schema }),
      // sql.begin() is a real transaction — keep it that way.
      transaction: (fn) => sql.begin((tx) => fn(drizzlePg(tx, { schema }))),
    };
  }
  return neonAdapter({
    connectionString,
    ...(hyperdrive ? { hyperdrive } : {}),
  });
}
```

You do **not** need a custom `db.execute()` result-shape shim: `createKernel`
normalizes `db.execute()` to a row array across drivers (postgres-js, neon-http,
node-postgres) automatically. `defineConfig` accepts **any** `DatabaseAdapter`,
so this drops straight in.

### Lock timeouts

`@porulle/adapter-postgres` sets `lock_timeout` to 10s by default. The Neon
transports do not, so a contended row lock waits on the PostgreSQL default —
unbounded — until the Worker's own limit trips. Contention on these paths is
rare, but if you want the ceiling, set it on the role rather than in code:

```sql
ALTER ROLE app SET lock_timeout = '10s';
```

Note that transaction-mode poolers reject `lock_timeout` as a startup
parameter, which is why it belongs on the role.

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
from a cron trigger calling `server.runJobs()` (one runner tick):

```toml
# wrangler.toml
[triggers]
crons = ["*/5 * * * *"]

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "acme-media"
```

```ts
async scheduled(_e, env, ctx) {
  const server = await getServer(env);
  ctx.waitUntil(server.runJobs());
}
```

## 5. Storage

Use [`@porulle/adapter-r2`](../packages/adapters/adapter-r2/README.md) for media
on Workers (the R2 binding is a native object — no AWS SDK). For a catalog-only
deployment with no media, omit `storage` entirely: `defineConfig` defaults to a
no-op adapter and `/api/media/upload` returns `501 storage_not_supported`.
