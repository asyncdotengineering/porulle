# TODO: Type-Safe SDK Client from OpenAPI Spec

## Problem

The current `packages/sdk/` has:
- **678 lines** of hand-written TypeScript interfaces (`CatalogEntity`, `Order`, `Cart`, etc.)
- **82 route definitions** manually maintained in `generator.ts`
- Types drift from the actual API — when a field is added to a Drizzle schema, the SDK doesn't know

Now that we serve a full OpenAPI 3.0 spec at `GET /api/doc` (118 paths, 148 operations, 77 schemas), we can generate a **fully typed client** that stays in sync automatically.

## Approach: `openapi-ts` + `openapi-fetch`

**`openapi-typescript`** generates TypeScript types from an OpenAPI spec.
**`openapi-fetch`** creates a type-safe `fetch` wrapper using those types.

Together they give:

```typescript
import createClient from "openapi-fetch";
import type { paths } from "./generated/api"; // auto-generated from /api/doc

const client = createClient<paths>({ baseUrl: "http://localhost:4001" });

// Fully typed — autocomplete on paths, params, body, response
const { data, error } = await client.GET("/api/orders/{idOrNumber}", {
  params: { path: { idOrNumber: "ORD-001" } },
});
// data is typed as { id: string, orderNumber: string, status: string, ... }

const { data: cart } = await client.POST("/api/carts", {
  body: { currency: "USD" },
});
// cart is typed as { id: string, customerId: string, ... }

// Compile error — path doesn't exist
await client.GET("/api/nonexistent"); // TS Error!

// Compile error — wrong body type
await client.POST("/api/checkout", {
  body: { wrongField: true }, // TS Error!
});
```

## Implementation Plan

### Step 1: Generate Types from Live Spec

```bash
# Install
bun add -d openapi-typescript

# Generate types from running server
npx openapi-typescript http://localhost:4001/api/doc -o packages/sdk/src/generated/api.d.ts

# Or from saved spec file
curl -s http://localhost:4001/api/doc > packages/sdk/openapi.json
npx openapi-typescript packages/sdk/openapi.json -o packages/sdk/src/generated/api.d.ts
```

### Step 2: Create Typed Client Wrapper

```typescript
// packages/sdk/src/client.ts
import createClient from "openapi-fetch";
import type { paths } from "./generated/api";

export function createCommerceClient(options: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers: {
      "Content-Type": "application/json",
      ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
      ...options.headers,
    },
  });
}

export type CommerceClient = ReturnType<typeof createCommerceClient>;
export type { paths } from "./generated/api";
```

### Step 3: Add Build Script

```json
// packages/sdk/package.json
{
  "scripts": {
    "generate": "openapi-typescript http://localhost:4001/api/doc -o src/generated/api.d.ts",
    "generate:file": "openapi-typescript openapi.json -o src/generated/api.d.ts",
    "build": "bun run generate:file && tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "openapi-fetch": "^0.13.0"
  },
  "devDependencies": {
    "openapi-typescript": "^7.0.0"
  }
}
```

### Step 4: Usage in Storefronts

```typescript
import { createCommerceClient } from "@unifiedcommerce/sdk";

const commerce = createCommerceClient({
  baseUrl: "https://api.mystore.com",
  apiKey: process.env.COMMERCE_API_KEY,
});

// Browse catalog — fully typed
const { data: products } = await commerce.GET("/api/catalog/entities", {
  params: { query: { status: "active", limit: "12" } },
});

// Add to cart — body validated at compile time
const { data: cart } = await commerce.POST("/api/carts", {
  body: { currency: "USD" },
});

// Checkout — all fields typed
const { data: order } = await commerce.POST("/api/checkout", {
  body: {
    cartId: cart.data.id,
    paymentMethodId: "pm_card_visa",
  },
});

// Type error at compile time, not runtime
await commerce.POST("/api/checkout", {
  body: { wrongField: true }, // ← TypeScript error
});
```

### Step 5: Plugin SDK Extensions

Plugin routes are in the OpenAPI spec too, so the generated types include marketplace, POS, etc.:

```typescript
// Marketplace — auto-typed from OpenAPI spec
const { data: vendors } = await commerce.GET("/api/marketplace/vendors");

// Create vendor — body typed from Zod schema
const { data: vendor } = await commerce.POST("/api/marketplace/vendors", {
  body: { name: "Acme Co", commissionRateBps: 1000 },
});

// POS — also typed
const { data: session } = await commerce.POST("/api/pos/sessions", {
  body: { registerId: "register-1" },
});
```

## What This Replaces

| Current SDK | New SDK |
|-------------|---------|
| 678 lines of hand-written interfaces | Auto-generated from OpenAPI spec |
| 82 manually maintained route definitions | Derived from live spec (148 operations) |
| Types can drift from API | Types always match (regenerate on build) |
| No body validation at compile time | Full request/response typing |
| No autocomplete on paths | Full path autocomplete |
| Manual `fetch()` wrapper | `openapi-fetch` with interceptors, middleware |

## What to Keep from Current SDK

- The `CommerceClient` convenience wrapper (re-export with auth headers)
- The `CommerceApiResponse<T>` type alias (keep for backwards compat)
- The test suite (update to use new client)

## What to Delete

- All hand-written interfaces in `index.ts` (replaced by generated types)
- `generator.ts` and `ROUTE_DEFINITIONS` (replaced by OpenAPI spec)
- `generated-routes.ts` (no longer needed)

## Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `openapi-typescript` | Generate `.d.ts` from OpenAPI spec | Dev dependency |
| `openapi-fetch` | Type-safe fetch client | ~5 KB runtime |

## CI Integration

```yaml
# Regenerate types on every API change
- name: Generate SDK types
  run: |
    cd apps/runvae && bun run start &
    sleep 5
    cd packages/sdk && bun run generate
    git diff --exit-code src/generated/api.d.ts || echo "SDK types changed — commit needed"
```
