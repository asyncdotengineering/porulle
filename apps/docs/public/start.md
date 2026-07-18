# Scaffold a Porulle headless store

You are setting up a **Porulle** headless commerce API — a TypeScript, REST-only
commerce backend that owns orders, payments, refunds, inventory, and catalog.
This prompt gives you the **80%** (a runnable store, done) so you can focus on
the **20%** (this store's products, branding, and integrations).

The starter runs on an **embedded Postgres (PGlite)** — no database to install,
no connection string, no migration step. `pnpm install`, `pnpm dev`, and a real
commerce REST API is live.

## 1. Create the project (run this)

```bash
mkdir my-porulle-store && cd my-porulle-store
mkdir -p src
base=https://porulle.asyncdot.com/scaffold
curl -fsSL $base/package.json      -o package.json
curl -fsSL $base/commerce.config.ts -o commerce.config.ts
curl -fsSL $base/server.ts          -o src/server.ts
curl -fsSL $base/tsconfig.json      -o tsconfig.json
curl -fsSL $base/drizzle.config.ts  -o drizzle.config.ts
curl -fsSL $base/env.example        -o .env
curl -fsSL $base/gitignore          -o .gitignore
pnpm install    # or npm install / bun install
pnpm dev        # → REST API on http://localhost:4000/api
```

Verify it's live:

```bash
curl http://localhost:4000/health          # {"status":"ok","store":"My Porulle Store"}
curl http://localhost:4000/api/catalog/entities   # the (empty) catalog
```

That's a working store: catalog, cart, checkout, orders, inventory, payments,
auth + API keys, and an MCP endpoint at `/mcp` — all running.

## 2. What's already done (the 80%)

- **Runnable server** — `src/server.ts` (Hono) via `createServer(config)`.
- **Zero-infra database** — `commerce.config.ts` uses `pgliteAdapter(...)`; the
  schema is pushed on boot and the default org is seeded.
- **Config** — store name, catalog entity shape, auth (default org + API keys),
  flat-rate shipping, and a **mock payment gateway** so checkout works with no
  keys.
- **Media storage** — local filesystem adapter under `./.data`.

## 3. Your 20% (make it yours)

Edit `commerce.config.ts`:

1. **Catalog** — set `storeName` and the `entities.product.fields` / `variants`
   to your real product shape.
2. **Real payments** — `pnpm add @porulle/adapter-stripe`, then in `payments:`
   swap the mock for `stripeAdapter({ secretKey, webhookSecret })` and set the
   keys in `.env` (see the commented block there).
3. **Email** — `pnpm add @porulle/adapter-resend`, add `email.send`, set
   `RESEND_API_KEY`.
4. **Plugins** — add capabilities like `@porulle/plugin-loyalty`,
   `@porulle/plugin-reviews`, or the channel connectors — register them in
   `plugins:`.
5. **Production database** — swap `pgliteAdapter` → `postgresAdapter({ connectionString: process.env.DATABASE_URL })`
   (`pnpm add @porulle/adapter-postgres`). Same PostgreSQL, same code; run
   `pnpm drizzle-kit push` once against the real DB.

## 4. Go deeper

- Full docs: <https://porulle.asyncdot.com>
- LLM-ready docs (one fetch): <https://porulle.asyncdot.com/llms-full.txt>
- Any docs page as raw Markdown: append `.md` to its URL.

Build the store. Keep the config the single source of truth.
