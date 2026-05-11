<div align="center">

<img src="./assets/mascot.png" alt="Porulle mascot — chibi merchant holding a parcel" width="180" />

# Porulle

**The headless commerce framework you own.**

[![docs](https://img.shields.io/badge/docs-porulle--docs.vercel.app-d4a574?logo=astro&logoColor=white)](https://porulle-docs.vercel.app)
[![npm](https://img.shields.io/npm/v/@porulle/core?label=%40porulle%2Fcore&color=cb3837&logo=npm)](https://www.npmjs.com/package/@porulle/core)
[![status: alpha](https://img.shields.io/badge/status-alpha-orange)](#status)
[![active development](https://img.shields.io/badge/active%20development-yes-2ea44f)](https://github.com/asyncdotengineering/porulle/commits/main)
[![straight out of the oven](https://img.shields.io/badge/%F0%9F%94%A5-straight%20out%20of%20the%20oven-d4a574)](#status)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/bun-1.3-ffd4a3?logo=bun&logoColor=black)](https://bun.sh)
[![Node ≥18](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)

**📚 Docs:** [porulle-docs.vercel.app](https://porulle-docs.vercel.app)

</div>

> **Porulle** (pronounced *poh-ROO-leh*, rhymes with Pirelli) is a TypeScript-first, source-available, self-host-first framework for building **headless commerce systems**. The Tamil root *porul* (பொருள் — *thing / substance / merchandise / meaning*) is hidden inside the spelling.

You install it the way you install Payload, Inngest, or Temporal:

```bash
bunx @porulle/cli init my-store
```

Porulle gives you the atoms — catalog, cart, checkout, orders, inventory, payments, fulfillment, search, multi-tenancy, plugins, hooks — wired through a single `defineConfig`, exposed as a hardened REST API. Your storefront supplies the presentation layer.

> 🔥 **Straight out of the oven.** Active development, alpha-grade. Things will change. Star the repo and yell at us in [Issues](https://github.com/asyncdotengineering/porulle/issues) when they do.

---

## Why Porulle

- **Universal entity model** — products, services, gift cards, subscriptions through one `sellable_entities` table
- **Plugin architecture** — extend with hooks, routes, schema, analytics models, permission scopes (PayloadCMS-style config-transform)
- **Adapter discipline** — swap PostgreSQL / Stripe / S3 / Meilisearch behind clean interfaces; vendor SDKs never leak into core
- **Multi-tenant by default** — every row is org-scoped; cross-tenant access is a closed surface
- **Durable job queue** — `FOR UPDATE SKIP LOCKED` claim-based, survives cold starts, runs on serverless cron triggers
- **Typed state machines** — order lifecycle, fulfillment, refunds with enforced transitions
- **Hardened by audit** — SSRF guards, CSRF, body limits, rate limits (per-IP + per-account), `__Secure-` cookies, CSP hook, magic-byte MIME validation, pricing/cart/media cross-tenant tests, every mutation in audit log

[Adopter contracts](https://porulle-docs.vercel.app/extending/) — Plugin Contract, Payment Adapter Contract, [Security Model](./SECURITY.md) — codify the rules so plugins inherit the security guarantees without rebuilding the bug class.

---

## Quick Start

### 60-second start (CLI starter)

```bash
bunx @porulle/cli init my-store
cd my-store
bun install
bun run db:push                # apply schema to PostgreSQL
bun run dev                    # http://localhost:4000
```

The CLI scaffolds a working `commerce.config.ts`, drops a `.env.example`, and points at a local PostgreSQL. For a real production install, jump to **[Your first production store](#your-first-production-store)** below.

### Development setup (clone the monorepo)

**Prerequisites:** [Bun ≥1.3](https://bun.sh), Node ≥18, PostgreSQL.

```bash
git clone https://github.com/asyncdotengineering/porulle.git
cd porulle
bun install

# point at your local Postgres
export DATABASE_URL=postgres://localhost:5432/porulle_dev

# scaffold the schema and seed the example store
cd apps/store-example
bun run db:push
bun run seed

# start the dev server
bun run dev
```

Open http://localhost:4000:

| Endpoint | What |
|---|---|
| `GET /health` | liveness + DB probe |
| `GET /api/reference` | Scalar API explorer (dev only) |
| `GET /api/doc` | OpenAPI spec |
| `POST /api/auth/sign-up/email` | Better Auth — sign up |
| `POST /api/checkout` | the checkout pipeline |

---

## Configure your store

Everything starts with a single `commerce.config.ts`:

```ts
import { defineConfig } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { stripePayments } from "@porulle/adapter-stripe";
import { localStorageAdapter } from "@porulle/adapter-local-storage";
import { loyaltyPlugin } from "@porulle/plugin-loyalty";

export default defineConfig({
  storeName: "Acme Streetwear",
  databaseAdapter: postgresAdapter({
    connectionString: process.env.DATABASE_URL!,
    pool: { pooled: !process.env.DATABASE_URL!.includes("localhost") },
  }),
  storage: localStorageAdapter({ basePath: "./.data/media", baseUrl: "http://localhost:4000/assets" }),
  payments: [stripePayments({ secretKey: process.env.STRIPE_SECRET_KEY! })],
  auth: {
    requireEmailVerification: true,
    defaultOrganizationId: "org_default",       // B2C single-storefront
    trustedOrigins: ["http://localhost:4000"],
  },
  entities: {
    product: {
      fields: [
        { name: "weight", type: "number", unit: "grams" },
        { name: "material", type: "text" },
      ],
      variants: { enabled: true, optionTypes: ["size", "color"] },
      fulfillment: "physical",
    },
  },
  plugins: [
    loyaltyPlugin({ pointsPerDollar: 1, tierThresholds: { silver: 500, gold: 1500 } }),
  ],
});
```

Boot it:

```ts
import { createServer } from "@porulle/core";
import config from "./commerce.config";

const { app } = await createServer(config);
export default app;   // works on Bun, Node (@hono/node-server), Cloudflare Workers
```

---

## Your first production store

The same `commerce.config.ts` you ran locally is the production config. The only difference is the values you feed it.

### 1. Provision a Postgres

Any managed Postgres works — Neon, Supabase, Railway, Fly Postgres, RDS. Neon's free tier is the fastest path:

```bash
# https://console.neon.tech (or `npx neonctl projects create`)
export DATABASE_URL="postgres://USER:PASSWORD@ep-xxxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require"
```

### 2. Wire real adapters

Swap the dev mocks for hosted services. Every adapter is a `bun add @porulle/adapter-*` away:

```ts title="commerce.config.ts"
import { defineConfig } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { stripePayments } from "@porulle/adapter-stripe";
import { s3StorageAdapter } from "@porulle/adapter-s3";
import { resendEmailAdapter } from "@porulle/adapter-resend";

export default defineConfig({
  storeName: "Acme Streetwear",
  databaseAdapter: postgresAdapter({
    connectionString: process.env.DATABASE_URL!,
    pool: { pooled: true },
  }),
  payments: [stripePayments({ secretKey: process.env.STRIPE_SECRET_KEY! })],
  storage: s3StorageAdapter({
    bucket: process.env.S3_BUCKET!,
    region: "us-east-1",
    publicBaseUrl: process.env.S3_PUBLIC_URL!,
  }),
  email: { send: resendEmailAdapter({
    apiKey: process.env.RESEND_API_KEY!,
    from: "Acme <orders@acme.com>",
  })},
  auth: {
    requireEmailVerification: true,
    apiKeys: { enabled: true },
    trustedOrigins: ["https://acme.com"],
  },
  entities: { product: { variants: { enabled: true, optionTypes: ["size", "color"] }, fulfillment: "physical" } },
});
```

### 3. Migrate + deploy

```bash
bun run db:push                    # apply schema to your hosted Postgres
bun run build && bun run start     # any host that runs Bun, Node, or CF Workers
```

[Vercel, Fly, Railway, Cloudflare Workers — full deploy recipes](https://porulle-docs.vercel.app/production/deployment/).

### 4. Mint an admin API key

The CLI talks to your live server and creates a scoped key:

```bash
porulle api-key create \
  --server https://api.acme.com \
  --name "admin-cli" \
  --scopes "*:*"

# → pak_live_…  (copy it, you won't see it again)
```

[Read about API key scopes →](https://porulle-docs.vercel.app/building/authentication/#api-keys)

### 5. Use the SDK to create your first product

`@porulle/sdk` is a typed client generated from your server's OpenAPI spec — every endpoint, body, and response is type-checked at compile time.

```bash
bun add @porulle/sdk
bun add -d openapi-typescript

# generate types from your live server
bunx @porulle/sdk generate --url https://api.acme.com/api/doc --out src/api-types.ts
```

```ts title="scripts/seed.ts"
import { createPorulleClient } from "@porulle/sdk";
import type { paths } from "./api-types";

const api = createPorulleClient<paths>({
  baseUrl: "https://api.acme.com",
  apiKey: process.env.PORULLE_ADMIN_KEY!,
});

// Create a product
const product = await api.POST("/api/admin/entities", {
  body: {
    type: "product",
    name: "Cotton Tee",
    slug: "cotton-tee",
    description: "Heavyweight 240gsm cotton.",
    fields: { weight: 240, material: "cotton" },
    variants: [
      { sku: "TEE-S-BLK", optionValues: { size: "S", color: "black" }, price: 2900 },
      { sku: "TEE-M-BLK", optionValues: { size: "M", color: "black" }, price: 2900 },
      { sku: "TEE-L-BLK", optionValues: { size: "L", color: "black" }, price: 2900 },
    ],
  },
});

if (product.error) throw new Error(product.error.message);
console.log(`✓ Created product ${product.data.id}`);

// Set inventory for the warehouse
await api.POST("/api/admin/inventory/levels", {
  body: {
    entityId: product.data.id,
    locationId: "wh_main",
    levels: product.data.variants.map((v) => ({ variantId: v.id, available: 100 })),
  },
});

// Publish to the storefront
await api.PATCH("/api/admin/entities/{id}", {
  params: { path: { id: product.data.id } },
  body: { status: "published" },
});

console.log(`✓ Live at https://acme.com/products/${product.data.slug}`);
```

```bash
PORULLE_ADMIN_KEY=pak_live_… bun run scripts/seed.ts
```

That's it — your first product is live, inventoried, published, and reachable via `GET /api/catalog/entities/cotton-tee`.

[Full SDK reference →](https://porulle-docs.vercel.app/frontend/sdk/) &nbsp;&middot;&nbsp; [Provisioning guide →](https://porulle-docs.vercel.app/building/admin-via-sdk/)

---

## Architecture

```
                    ┌─────────────────────────────────┐
                    │     defineConfig(...)           │
                    │  (single source of truth)       │
                    └─────────────────────────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
        ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
        │   Adapters    │  │   Plugins     │  │   Hooks       │
        │ (db, pay,     │  │ (loyalty,     │  │ (before/after │
        │  storage,     │  │  marketplace, │  │  every op)    │
        │  search, tax) │  │  reviews, …)  │  │               │
        └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
                └──────────────────┼──────────────────┘
                                   ▼
                    ┌─────────────────────────────────┐
                    │       Kernel + Services         │
                    │  catalog, cart, checkout,       │
                    │  orders, inventory, payments,   │
                    │  fulfillment, customers, …      │
                    └─────────────────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────────┐
                    │  REST API (Hono + OpenAPI)      │
                    │  /api/catalog  /api/cart  …     │
                    └─────────────────────────────────┘
```

The kernel is interface-agnostic. The shipped interface is REST. Adopters who want MCP / UCP / ACP / custom RPC layers wrap the REST API or the in-process `LocalAPI`.

---

## Packages

| Package | Purpose |
|---|---|
| `@porulle/core` | the kernel: services, hooks, state machines, auth, runtime |
| `@porulle/cli` | `init`, `dev`, `migrate`, `api-key`, `doctor` |
| `@porulle/sdk` | typed TypeScript SDK + React Query bindings |
| `@porulle/adapter-postgres` | the (only, today) database adapter |
| `@porulle/adapter-stripe` | payment adapter — reference implementation |
| `@porulle/adapter-{s3,r2,local-storage}` | media storage adapters |
| `@porulle/adapter-{meilisearch,pg-search}` | search adapters |
| `@porulle/adapter-{taxjar,tax-manual}` | tax adapters |
| `@porulle/adapter-{resend,ses}` | transactional email adapters |
| `@porulle/plugin-marketplace` | multi-vendor marketplace (vendors, sub-orders, commissions, payouts, disputes) |
| `@porulle/plugin-{loyalty,reviews,gift-cards,wishlist,…}` | first-party plugins |

---

## Status

**v0.1.0 alpha.** What's stable: REST API, multi-tenant kernel, plugin contract, adapter contracts, security model. What's not: agent-native primitives (Phase 2 — principal model rework, multi-protocol gateway, conversation layer). See [`SECURITY.md`](./SECURITY.md) for the threat model and the Phase 2 roadmap.

This framework was extracted from a production e-commerce engine after a five-round adversarial security review. Every cross-tenant leak, race condition, IDOR, and information-disclosure surface caught by the audit was fixed and pinned with a regression test before the rename.

---

## Contributing

```bash
bun install
bun run check-types
bun test
bun run lint
```

Adopter contracts (plugin contract, payment adapter contract) live in the docs site under [Extending Porulle](https://github.com/asyncdotengineering/porulle/tree/main/apps/docs/src/content/docs/extending). Read these first if you're writing a plugin, payment adapter, or extension.

Issues, RFCs, and security disclosures: open a GitHub issue or email the security contact in [`SECURITY.md`](./SECURITY.md).

---

## License

MIT. See [`LICENSE`](./LICENSE).
