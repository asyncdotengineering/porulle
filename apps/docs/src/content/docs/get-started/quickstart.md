---
title: Quickstart
description: A working commerce API in five minutes — three files, two commands, five curl requests.
---

This guide gets you from zero to a running commerce API with products, cart, and checkout. You will create three files, run two commands, and make five API calls.

For a full walkthrough with seed data, inventory, and multiple entity types, see [Your First Store](/tutorials/first-store/).

## 1. Create the config

Every Porulle app starts with `commerce.config.ts`. This file declares your store's entity types, adapters, auth, shipping, and plugins.

```ts title="commerce.config.ts"
import { defineConfig, Ok, type PaymentAdapter } from "@porulle/core";
import { postgresAdapter } from "@porulle/adapter-postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://localhost:5432/porulle_dev";

const mockPayments: PaymentAdapter = {
  providerId: "mock-payments",
  async createPaymentIntent(params) {
    return Ok({
      id: `pi_${Date.now()}`,
      status: "requires_capture",
      amount: params.amount,
      currency: params.currency,
      clientSecret: `secret_${Date.now()}`,
    });
  },
  async capturePayment(id, amount) {
    return Ok({ id, status: "succeeded", amountCaptured: amount ?? 0 });
  },
  async refundPayment(_id, amount) {
    return Ok({ id: `re_${Date.now()}`, status: "succeeded", amountRefunded: amount });
  },
  async cancelPaymentIntent() { return Ok(undefined); },
  async verifyWebhook() {
    return Ok({ id: "evt_mock", type: "payment.succeeded", data: {} });
  },
};

export default defineConfig({
  storeName: "My Store",
  databaseAdapter: postgresAdapter({ connectionString: DATABASE_URL }),

  auth: {
    requireEmailVerification: false,
    // Required. With neither this nor `storeResolver`, `createServer` refuses
    // to construct rather than 503-ing on the first request that carries no
    // actor. Single-store deployments set this one.
    defaultOrganizationId: "org_quickstart",
    apiKeys: { enabled: true },
    // Every API key is minted against a named scope. There is no built-in
    // development key.
    apiKeyScopes: {
      admin: {
        prefix: "qs_adm_",
        description: "Quickstart admin access",
        permissions: {
          catalog: ["read", "read:unpublished", "create", "update", "delete"],
          cart: ["create", "read", "update"],
          orders: ["read", "create", "update"],
        },
      },
    },
    trustedOrigins: ["http://localhost:4000"],
    roles: {
      admin: { permissions: ["*:*"] },
      customer: {
        permissions: [
          "catalog:read",
          "cart:create", "cart:read", "cart:update",
          "orders:create", "orders:read:own",
        ],
      },
    },
  },

  entities: {
    product: {
      fields: [{ name: "weight", type: "number", unit: "grams" }],
      variants: { enabled: true, optionTypes: ["size", "color"] },
      fulfillment: "physical",
    },
  },

  shipping: {
    type: "flat",
    flatRate: 500,
    freeShippingThreshold: 10000,
    brackets: [],
    fallbackCost: 500,
  },

  payments: [mockPayments],
});
```

## 2. Create the server

```ts title="src/server.ts"
import { serve } from "@hono/node-server";
import { createServer } from "@porulle/core";
import config from "../commerce.config.js";

const PORT = Number(process.env.PORT ?? 4000);

// createServer is async and returns { app, kernel, logger, commerce, runJobs }.
const { app } = await createServer(await config);

app.get("/health", (c) => c.json({ status: "ok" }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Store running at http://localhost:${info.port}`);
});
```

## 3. Create the Drizzle config

```ts title="drizzle.config.ts"
import { defineConfig } from "drizzle-kit";
import { getSchemaFiles } from "@porulle/core";

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/porulle_dev",
  },
  // Ask the package where its schema lives. Hardcoding paths into
  // node_modules breaks on the next layout change, and pointing them at `src`
  // rather than `dist` silently migrates a different copy than the one your
  // server loads.
  schema: getSchemaFiles(),
});
```

## 4. Push schema and start

```bash
bunx drizzle-kit push --config drizzle.config.ts
bun run src/server.ts
```

You should see `Store running at http://localhost:4000`.

## 5. Mint an API key

There is no built-in development key. Mint one against the `admin` scope you
declared in step 1:

```bash
bunx @porulle/cli api-key create --scope admin --save-env --env-var PORULLE_API_KEY
```

The key is printed once and written to `.env.local`. Load it into your shell for
the next step:

```bash
export PORULLE_API_KEY=$(grep PORULLE_API_KEY .env.local | cut -d= -f2)
```

## 6. Try it

Run these in a new terminal. The `x-api-key` header presents the key you just
minted; its permissions come from the `admin` scope, not from the request.

```bash
# Create a product
ENTITY=$(curl -s -X POST http://localhost:4000/api/catalog/entities \
  -H "content-type: application/json" \
  -H "x-api-key: $PORULLE_API_KEY" \
  -d '{"type":"product","slug":"classic-tee","status":"active","metadata":{}}')
ENTITY_ID=$(echo $ENTITY | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "Entity: $ENTITY_ID"

# Create a cart
CART=$(curl -s -X POST http://localhost:4000/api/carts \
  -H "content-type: application/json" \
  -H "x-api-key: $PORULLE_API_KEY" \
  -d '{"currency":"USD"}')
CART_ID=$(echo $CART | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "Cart: $CART_ID"

# Add an item (price in cents: 2999 = $29.99)
curl -s -X POST "http://localhost:4000/api/carts/$CART_ID/items" \
  -H "content-type: application/json" \
  -H "x-api-key: $PORULLE_API_KEY" \
  -d "{\"entityId\":\"$ENTITY_ID\",\"quantity\":1,\"unitPriceSnapshot\":2999}"

# Checkout
curl -s -X POST http://localhost:4000/api/checkout \
  -H "content-type: application/json" \
  -H "x-api-key: $PORULLE_API_KEY" \
  -d "{
    \"cartId\":\"$CART_ID\",
    \"paymentMethodId\":\"mock-payments\",
    \"currency\":\"USD\",
    \"shippingAddress\":{
      \"country\":\"US\",\"postalCode\":\"90210\",
      \"city\":\"Beverly Hills\",\"line1\":\"1 Commerce Ave\"
    }
  }"
```

The checkout response includes an `orderNumber` (e.g., `ORD-2026-000001`), a calculated `grandTotal`, and a `status` of `pending`.

> **Note on API keys:** there is no built-in development key — `auth.enableDevKey` and `auth.devKey` were removed, and the server refuses to start if either is set. Declare a scope under `auth.apiKeyScopes`, then mint against it with `bunx @porulle/cli api-key create --scope <name>`. See [Authentication](/building/authentication/#api-keys).

## What just happened

The checkout pipeline ran eight steps in order: validated the cart, resolved prices, checked inventory (0 stock is fine in this quickstart), applied promotions, calculated tax, calculated shipping ($5 flat rate), authorized payment via the mock adapter, and created the order. Each step is a hook — you can intercept any of them.

## Next steps

- [Your First Store tutorial](/tutorials/first-store/) — a complete walkthrough with real inventory, seed data, and multiple entity types
- [Build a Loyalty Plugin tutorial](/tutorials/build-a-plugin/) — extend the checkout pipeline with custom logic
- [Configuration reference](/reference/configuration/) — every `defineConfig` option documented
