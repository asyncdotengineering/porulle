# SDK and Frontend Reference

## How the SDK Works

The SDK does NOT ship pre-generated types. Instead:

1. You generate types from YOUR running server's OpenAPI spec
2. You create a generic typed client parameterized by YOUR paths
3. All routes (core + your plugins) are compile-time checked

## Install

```bash
bun add @porulle/sdk
# For React: also add peer dependencies
bun add @tanstack/react-query openapi-react-query
# For codegen: dev dependency
bun add -d openapi-typescript
```

## Step 1: Generate Types from Your Server

```bash
# Start your server first, then:
bunx @porulle/sdk generate

# Or with custom URL:
bunx @porulle/sdk generate --url http://localhost:3000/api/doc

# Or custom output path:
bunx @porulle/sdk generate --output src/types/api.ts
```

This fetches `/api/doc` (the OpenAPI spec), runs `openapi-typescript`, and outputs a `paths` type that covers every route — core AND your installed plugins.

**Commit the generated file.** Regenerate when you add plugins or change routes.

## Step 2: Create a Typed Client

```ts
import { createClient } from "@porulle/sdk";
import type { paths } from "./generated/api-types";

// API key auth (server-to-server, CI, AI agents)
const client = createClient<paths>({
  baseUrl: "http://localhost:3000",
  auth: { type: "api_key", key: process.env.API_KEY! },
});

// Bearer token auth (mobile apps, SPAs)
const client = createClient<paths>({
  baseUrl: "http://localhost:3000",
  auth: { type: "bearer", token: sessionToken },
});
```

`createClient<paths>()` returns a typed `openapi-fetch` client. Every path, method, body, query param, and response is compile-time validated against YOUR generated types.

## Step 3: Make Typed Requests

```ts
// All paths are autocompleted and type-checked
const { data } = await client.GET("/api/catalog/entities", {
  params: { query: { type: "product", limit: "20" } },
});

const { data: cart } = await client.POST("/api/carts", {
  body: { currency: "USD" },
});

await client.POST("/api/carts/{id}/items", {
  params: { path: { id: cart.data.id } },
  body: { entityId: "...", quantity: 2 },
});

const { data: order } = await client.POST("/api/checkout", {
  body: {
    cartId: cart.data.id,
    paymentMethodId: "stripe",
    currency: "USD",
    shippingAddress: { line1: "123 Main St", city: "NYC", country: "US", firstName: "Jane", lastName: "Doe" },
  },
});

// Plugin routes are typed too
const { data: slots } = await client.GET("/api/appointments/availability/{providerId}/slots", {
  params: { path: { providerId: "..." }, query: { date: "2026-03-20", serviceTypeId: "..." } },
});
```

## Error Handling

Every method returns `{ data, error, response }`. Only one of `data` or `error` is present.

```ts
const { data, error } = await client.GET("/api/catalog/entities/{idOrSlug}", {
  params: { path: { idOrSlug: "nonexistent" } },
});

if (error) {
  console.log(error.error.code);    // "NOT_FOUND"
  console.log(error.error.message); // "Entity not found"
  return;
}

// data is guaranteed non-null here
console.log(data.data.id);
```

## React Hooks (TanStack Query)

```ts
import { createClient } from "@porulle/sdk";
import { createCommerceHooks } from "@porulle/sdk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { paths } from "./generated/api-types";

const client = createClient<paths>({ baseUrl: "", auth: { type: "api_key", key: "..." } });
const commerce = createCommerceHooks(client);
const queryClient = new QueryClient();

// Wrap your app
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Products />
    </QueryClientProvider>
  );
}

// Read data — path, params, and response all typed
function Products() {
  const { data, isLoading } = commerce.useQuery("get", "/api/catalog/entities", {
    params: { query: { type: "product", limit: "20" } },
  });
  if (isLoading) return <p>Loading...</p>;
  return <ul>{data?.data.map(p => <li key={p.id}>{p.slug}</li>)}</ul>;
}

// Mutate data
function AddToCartButton({ cartId, entityId }: { cartId: string; entityId: string }) {
  const addItem = commerce.useMutation("post", "/api/carts/{id}/items");
  return (
    <button
      disabled={addItem.isPending}
      onClick={() => addItem.mutate({
        params: { path: { id: cartId } },
        body: { entityId, quantity: 1 },
      })}
    >Add to Cart</button>
  );
}
```

## Next.js In-Process (Recommended)

Mount Hono inside a Next.js App Router catch-all route. No separate server.

```ts title="app/api/[[...route]]/route.ts"
import { handle } from "hono/vercel";
import { createServer } from "@porulle/core";
import config from "../../../../commerce.config";

const { app } = await createServer(await config);

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
```

Frontend calls `/api/catalog/entities` and it routes through Hono in the same process. No CORS, no proxy, no separate port.

For the SDK client, use empty `baseUrl` since API is on the same origin:

```ts
const client = createClient<paths>({ baseUrl: "", auth: { ... } });
```

## Convenience Wrapper (Quick Scripts)

For one-off scripts where you don't need codegen, `createSDK()` provides untyped domain namespaces:

```ts
import { createSDK } from "@porulle/sdk";

const sdk = createSDK({ baseUrl: "http://localhost:3000", auth: { type: "api_key", key: "..." } });
await sdk.catalog.list({ type: "product" });
await sdk.cart.create({ currency: "USD" });
```

These are untyped (no compile-time validation). For production code, always use `createClient<paths>()` with generated types.

## Authentication Methods

| Method | Header | Best for |
|--------|--------|----------|
| Session cookie | Auto-set by browser | Web storefronts, admin panels |
| Bearer token | `Authorization: Bearer <token>` | Mobile apps, SPAs |
| API key | `x-api-key: <key>` | Server-to-server, CI, AI agents |

## SDK Codegen Workflow

```bash
# After adding/removing plugins or changing routes:
bun run dev                                    # start server
bunx @porulle/sdk generate             # regenerate types
git add src/generated/api-types.ts && git commit  # commit
```
