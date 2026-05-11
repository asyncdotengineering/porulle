# Deployment Reference

## Environment Variables

Required for every deployment:

```bash
DATABASE_URL=postgres://user:password@host:5432/my_store
BETTER_AUTH_SECRET=<random 32+ char string>
BETTER_AUTH_URL=https://your-domain.com
```

## Database Migrations

Development: `bunx drizzle-kit push` (direct schema push)
Production: `bunx drizzle-kit generate && bunx drizzle-kit migrate` (versioned migrations)

## Bun (Recommended)

No adapter needed. Hono works directly with Bun's built-in server:

```ts title="src/server.ts"
import { createServer } from "@porulle/core";
import config from "./commerce.config.js";

const { app } = await createServer(await config);
export default { port: Number(process.env.PORT ?? 4000), fetch: app.fetch };
```

```bash
bun run src/server.ts
```

## Node.js

```bash
bun add @hono/node-server
```

```ts title="src/server.ts"
import { serve } from "@hono/node-server";
import { createServer } from "@porulle/core";
import config from "./commerce.config.js";

const { app } = await createServer(await config);
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4000) });
```

## Vercel (Hono Zero-Config)

Set Framework Preset to **"Hono"** in the Vercel dashboard.

```ts title="src/index.ts"
import { createServer } from "@porulle/core";
import config from "../commerce.config.js";

const { app } = await createServer(await config);
export default app;
```

No `vercel.json`, no `handle()` wrapper needed. All workspace packages must have conditional exports pointing to compiled `dist/*.js` files.

| Setting | Value |
|---------|-------|
| Framework Preset | Hono |
| Root Directory | `apps/your-app` |
| Install Command | `bun install` |

Required env vars: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.

## Next.js App Router

```ts title="app/api/[[...route]]/route.ts"
import { handle } from "hono/vercel";
import { createServer } from "@porulle/core";
import config from "../../../commerce.config.js";

const { app } = await createServer(await config);
export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
```

## Cloudflare Workers

```ts title="src/worker.ts"
import { createServer } from "@porulle/core";
import config from "./commerce.config.js";

const { app } = await createServer(await config);
export default app;
```

```bash
wrangler deploy src/worker.ts
wrangler secret put DATABASE_URL
```

## Docker

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx drizzle-kit migrate --config drizzle.config.ts
EXPOSE 4000
CMD ["bun", "run", "src/server.ts"]
```

## Production Config Checklist

```ts
export default defineConfig({
  auth: {
    requireEmailVerification: true,
    trustedOrigins: ["https://mystore.com"],
    apiKeys: { enabled: true },
    apiKeyScopes: {
      storefront: { prefix: "uc_pub_", description: "Storefront", permissions: { catalog: ["read"], cart: ["create", "read", "update"], orders: ["create", "read"] } },
      admin: { prefix: "uc_adm_", description: "Admin", permissions: { "*": ["*"] } },
    },
  },
  rateLimits: { api: 100, auth: 10, checkout: 5 },
  jobs: { autorun: { enabled: true } },
});
```

- Generate real API keys: `bunx @porulle/cli api-key create --scope admin`
- Set real `trustedOrigins` (CORS + CSRF)
- Enable email verification
- Configure rate limits
- Enable job queue autorun
- Use `drizzle-kit migrate` (not `push`) for schema changes
