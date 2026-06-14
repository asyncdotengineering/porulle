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

## 2. Environment-aware database adapter (local vs deployed)

The reliable **deployed** Workers DB path is Neon's HTTP driver
(`@neondatabase/serverless` + `drizzle-orm/neon-http`) — `postgres-js` over the
`nodejs_compat` TCP polyfill is intermittently unreliable at the edge.

But neon-http **fails under local `wrangler dev`** (miniflare). The two failure
modes are disjoint, so pick the driver by environment: **TCP locally,
neon-http deployed.**

```ts
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import type { DatabaseAdapter } from "@porulle/core";
import * as schema from "@porulle/core/schema";

// Hyperdrive's local connection string points at localhost during wrangler dev.
const isLocalDev = (cs: string) => /(?:localhost|127\.0\.0\.1|\[::1\])/.test(cs);

export function workersDbAdapter(connectionString: string): DatabaseAdapter {
  if (isLocalDev(connectionString)) {
    const sql = postgres(connectionString, { prepare: false, max: 5 });
    const db = drizzlePg(sql, { schema });
    return { provider: "postgresql", db, transaction: (fn) => sql.begin((tx) => fn(drizzlePg(tx, { schema }))) };
  }
  const sql = neon(connectionString);
  const db = drizzleNeon(sql, { schema });
  return { provider: "postgresql", db, transaction: (fn) => fn(db) };
}
```

You do **not** need a custom `db.execute()` result-shape shim: `createKernel`
normalizes `db.execute()` to a row array across drivers (postgres-js, neon-http,
node-postgres) automatically. `defineConfig` accepts **any** `DatabaseAdapter`,
so this drops straight in.

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
