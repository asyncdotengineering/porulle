# Acme Streetwear — Example Store Application

Complete example store demonstrating the UnifiedCommerce Engine with PostgreSQL, seed data, and E2E demo scripts.

## Prerequisites

- Node.js >= 20 (`nvm use 20`)
- PostgreSQL running locally on port 5432
- `bun` package manager

## Quick Start

```bash
# 1. Build the core package (required after any core changes)
cd packages/core && bun run build && cd ../..

# 2. Reset database, push schema, and seed data
cd apps/store-example
bun run setup

# 3. Start the dev server
bun run dev

# 4. In another terminal, run the demo scripts
bun run demo:all          # Full 10-step kernel-level lifecycle
bun run demo:browse       # Browse catalog, search, categories, brands
bun run demo:cart         # Cart → checkout → order → confirm
bun run demo:inventory    # Stock levels, warehouses, adjustments
bun run demo:analytics    # Revenue, order counts, top items, inventory value
bun run demo:admin        # Full admin workflow (catalog, restock, promotions, orders, fulfillment, search)
bun run demo:customer     # Customer registration, sign-in, profile, address, cart, checkout with promo
bun run demo:loyalty      # Loyalty points, leaderboard, redemption, tier progression
```

## Database Setup

The example uses PostgreSQL. Connection defaults to `postgres://localhost:5432/unified_commerce` (override with `DATABASE_URL`).

### Schema Management

The Drizzle schema is pushed directly to the database (no migration files needed for development):

```bash
# Push schema to existing database
bun run db:push

# Reset database (drop → create → push schema)
bun run db:reset

# Full setup (reset → seed)
bun run setup
```

`db:reset` runs this chain:
1. `DROP DATABASE unified_commerce`
2. `CREATE DATABASE unified_commerce`
3. `drizzle-kit push` — pushes all Drizzle schemas from `packages/core/src/modules/*/schema.ts` to the DB
4. Prints "Database reset complete"

`setup` adds seeding on top of `db:reset`.

### Generating Migrations (Production)

For production deployments, generate migration SQL files:

```bash
bun run db:generate
```

This creates versioned SQL files in the `drizzle/` directory at the repo root.

### Seed Data

The `seed` script (`bun run seed`) creates:

- **3 categories**: Tops, Bottoms, Accessories
- **2 brands**: Acme Originals, Street Collab
- **2 warehouses**: Main Warehouse (MAIN), Pop-up Store (POPUP)
- **5 products**: Classic Tee ($29.99), Oversized Hoodie ($79.99), Urban Cargo Pants ($64.99), Knit Beanie ($19.99), Crossbody Sling Bag ($44.99)
- **1 gift card**: Digital Gift Card ($50)
- **1 customer**: Jane Doe (jane@example.com)
- **1 promotion**: WELCOME10 (10% off orders, valid 90 days)

All products have prices, categories, brands, stock in both warehouses, and weight/material metadata.

## Running Demo Scripts

There are two types of demo scripts:

### Kernel-Level Scripts (no server needed)

These use the commerce kernel directly — no HTTP server required:

| Script | What it tests |
|--------|--------------|
| `demo:all` | Full 10-step lifecycle: catalog → pricing → inventory → customer → cart → order → status transitions → analytics |
| `demo:analytics` | Revenue summary, orders by status, top selling items, inventory value by warehouse, stock levels |

```bash
bun run demo:all
bun run demo:analytics
```

### HTTP REST API Scripts (server required)

These scripts hit the running server via HTTP. **Start the server first:**

```bash
# Terminal 1: start server
bun run dev

# Terminal 2: run scripts
bun run demo:browse       # GET /api/catalog, /api/catalog/:slug, /api/categories, /api/brands, /api/search
bun run demo:cart         # POST /api/cart, /api/cart/:id/items, /api/checkout, PATCH /api/orders/:id/status
bun run demo:inventory    # GET /api/inventory/:entityId, /api/warehouses, POST /api/inventory/adjust
bun run demo:admin        # Full admin: catalog, warehouses, restock, promotions, orders, fulfillment, search
bun run demo:customer     # Register, sign in, profile CRUD, addresses, browse, cart, checkout with promo code
bun run demo:loyalty      # Loyalty points, leaderboard, point redemption, tier progression
```

### Run All E2E Scripts

```bash
# Reset + seed + start server + run all scripts
bun run setup
bun run dev &
sleep 2

bun run demo:all
bun run demo:browse
bun run demo:cart
bun run demo:inventory
bun run demo:analytics
bun run demo:admin
bun run demo:customer
bun run demo:loyalty

kill %1  # stop the background server
```

## Authentication

### Development (Local)

Demo scripts use a hardcoded API key `dev-staff-key` (set in `src/scripts/_helpers.ts`) that provides staff permissions for local testing.

### Production

1. Create a Better Auth user account
2. Generate an API key via `auth.api.createApiKey()` or the REST endpoint
3. Set `STORE_API_KEY` environment variable:
   ```bash
   export STORE_API_KEY="sk_live_..."
   ```
4. Scripts use `STORE_API_KEY` when set, otherwise fall back to `dev-staff-key`

## Server Endpoints

The server runs on port 4000 (override with `PORT` env var):

| Endpoint | Description |
|----------|-------------|
| `http://localhost:4000/api` | REST API |
| `http://localhost:4000/mcp` | Model Context Protocol interface |
| `http://localhost:4000/health` | Health check |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://localhost:5432/unified_commerce` | PostgreSQL connection string |
| `STORE_API_KEY` | `dev-staff-key` | Better Auth API key |
| `PORT` | `4000` | Server port |
| `API_URL` | `http://localhost:4000` | Base URL for demo scripts |

## Project Structure

```
apps/store-example/
├── commerce.config.ts          # Store config (DB, adapters, roles, entities, shipping, plugins)
├── package.json                # Scripts and dependencies
├── tsconfig.json
├── src/
│   ├── server.ts               # Hono server with auth middleware
│   ├── plugins/
│   │   └── loyalty-plugin.ts   # Loyalty points plugin (hooks + routes)
│   └── scripts/
│       ├── _helpers.ts         # Shared fetch helper with API key header
│       ├── seed.ts             # Database seeding
│       ├── full-flow.ts        # Kernel-level full lifecycle (demo:all)
│       ├── analytics.ts        # Analytics queries (demo:analytics)
│       ├── browse-catalog.ts   # Catalog browsing (demo:browse)
│       ├── cart-and-checkout.ts # Cart + checkout (demo:cart)
│       ├── inventory-ops.ts    # Inventory operations (demo:inventory)
│       ├── demo-admin.ts       # Admin workflow (demo:admin)
│       ├── demo-customer.ts    # Customer journey (demo:customer)
│       └── demo-loyalty.ts     # Loyalty plugin test (demo:loyalty)
└── .data/media/                # Local storage for uploaded files
```

## Store Configuration

Configured in `commerce.config.ts`:

- **Database**: PostgreSQL via `@porulle/adapter-postgres`
- **Storage**: Local filesystem via `@porulle/adapter-local-storage`
- **Entity Types**: `product` (variants, weight/material fields), `gift_card`
- **Shipping**: Weight-based brackets (500g→$4.99 ... 5kg→$15.99, free over $100)
- **Payments**: Mock adapter (intents, captures, refunds)
- **Plugins**: Loyalty points (1 point/$1, tier thresholds at $500/$1500/$3000)
- **Roles**: owner, admin, staff, customer, ai_agent — each with granular permissions
