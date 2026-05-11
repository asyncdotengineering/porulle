---
title: Install
description: Prerequisites, package installation, database setup, and verification.
---

## Prerequisites

- **Bun 1.3+** or Node.js 20+
- **PostgreSQL 15+** running locally or remotely
- A package manager: Bun (recommended), npm, pnpm, or yarn

PostgreSQL must be reachable before running `db:push`. Local setup: `brew install postgresql@16 && brew services start postgresql@16`.

## Install packages

At minimum you need the core engine and a database adapter:

```bash
bun add @porulle/core @porulle/adapter-postgres
```

For a full store with payments, file storage, and search:

```bash
bun add @porulle/core \
        @porulle/adapter-postgres \
        @porulle/adapter-stripe \
        @porulle/adapter-local-storage \
        @porulle/adapter-pg-search
```

## Available packages

| Package | Purpose |
|---------|---------|
| `@porulle/core` | Kernel: services, hooks, state machines, auth, runtime |
| `@porulle/cli` | `init`, `dev`, `migrate`, `api-key`, `doctor` commands |
| `@porulle/sdk` | Typed TypeScript client + React Query bindings |
| `@porulle/adapter-postgres` | PostgreSQL database adapter (required) |
| `@porulle/adapter-stripe` | Stripe payment adapter |
| `@porulle/adapter-local-storage` | Local filesystem media storage |
| `@porulle/adapter-s3` | AWS S3 media storage |
| `@porulle/adapter-r2` | Cloudflare R2 media storage |
| `@porulle/adapter-meilisearch` | Meilisearch full-text search |
| `@porulle/adapter-pg-search` | PostgreSQL full-text search (no external service) |
| `@porulle/adapter-resend` | Resend transactional email |
| `@porulle/adapter-ses` | AWS SES transactional email |
| `@porulle/adapter-taxjar` | TaxJar tax calculation |
| `@porulle/adapter-tax-manual` | Flat-rate / manual tax |
| `@porulle/plugin-marketplace` | Multi-vendor marketplace |
| `@porulle/plugin-loyalty` | Points and tiers |
| `@porulle/plugin-reviews` | Product reviews |
| `@porulle/plugin-gift-cards` | Gift card management |
| `@porulle/plugin-pos` | Point-of-sale terminals, shifts, Z-reports |
| `@porulle/plugin-appointments` | Appointment scheduling |

## Database setup

Create a PostgreSQL database:

```bash
createdb porulle_dev
export DATABASE_URL="postgres://localhost:5432/porulle_dev"
```

Porulle uses [Drizzle ORM](https://orm.drizzle.team/) for schema management. After creating your `commerce.config.ts` (see [Quickstart](/get-started/quickstart/)), create a `drizzle.config.ts`:

```ts title="drizzle.config.ts"
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/porulle_dev",
  },
  schema: [
    "./node_modules/@porulle/core/src/kernel/database/schema.ts",
    "./node_modules/@porulle/core/src/auth/auth-schema.ts",
    "./node_modules/@porulle/plugin-*/src/schema.ts",
  ],
});
```

Push the schema:

```bash
bunx drizzle-kit push --config drizzle.config.ts
```

This creates all core tables (catalog, inventory, cart, orders, customers, pricing, promotions, fulfillment, media, webhooks, audit, jobs), Better Auth tables (user, session, account, organization, member), and any plugin tables you have installed.

Plugin schemas are discovered automatically via the glob pattern. Adding a new plugin and re-running `db:push` picks up its tables.

## Verify

Start the server and check the health endpoint:

```bash
bun run dev
curl http://localhost:4000/health
```

```json
{ "status": "ok", "store": "My Store" }
```

The OpenAPI spec is at `GET /api/doc`. The interactive Scalar explorer is at `GET /api/reference`.

## Next steps

- [Quickstart](/get-started/quickstart/) — create a working store in five minutes
- [Your First Store tutorial](/tutorials/first-store/) — a complete walkthrough with seed data
