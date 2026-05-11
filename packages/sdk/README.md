# @porulle/sdk

Typed TypeScript client for any Porulle server. Generated from the OpenAPI spec — every endpoint, request body, and response is type-checked at compile time.

## Two surfaces

```ts
import { createClient } from "@porulle/sdk";
import { createCommerceHooks } from "@porulle/sdk/react";
```

- **`createClient<paths>`** — a vanilla `openapi-fetch` client. Use anywhere (Node, Bun, browser, Cloudflare Workers).
- **`createCommerceHooks(client)`** — TanStack Query (React Query) hooks bound to that client.

## Usage

```ts
import { createClient } from "@porulle/sdk";
import type { paths } from "./generated/api-types";  // generate via openapi-typescript against your /api/doc

const client = createClient<paths>({
  baseUrl: "https://your-store.com",
  auth: { type: "api_key", key: process.env.PORULLE_API_KEY! },
});

const { data, error } = await client.GET("/api/catalog/entities", {
  params: { query: { type: "product", limit: 10 } },
});
```

React Query bindings:

```tsx
import { createCommerceHooks } from "@porulle/sdk/react";

const commerce = createCommerceHooks(client);

function ProductList() {
  const { data } = commerce.useQuery("get", "/api/catalog/entities", {
    params: { query: { type: "product" } },
  });
  return <ul>{data?.data.map(p => <li key={p.id}>{p.slug}</li>)}</ul>;
}
```

## Auth credentials

| Type | Header sent |
|---|---|
| `{ type: "api_key", key }` | `x-api-key: <key>` |
| `{ type: "bearer", token }` | `Authorization: Bearer <token>` |
| (omitted) | request goes anonymous; the server's auth middleware decides what's allowed |

## Generating types

The SDK is generic — bring your own `paths` type. Generate it from your server's OpenAPI doc:

```bash
bunx openapi-typescript http://localhost:4000/api/doc -o src/generated/api-types.ts
```

The shipped server exposes `/api/doc` (JSON) and `/api/reference` (Scalar UI in dev).

## See also

- [Root README](../../README.md)
- `apps/store-example/` — full app using the SDK
