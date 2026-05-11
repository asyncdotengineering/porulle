# RFC-016: Typed Commerce SDK Client

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-16
- **Scope:** `packages/sdk/`
- **Depends on:** `openapi-typescript` (codegen), `openapi-fetch` (runtime client), OpenAPI spec at `/api/doc`
- **Replaces:** Current hand-written SDK (678 lines, 82 routes, `JsonObject` body types)
- **Estimated effort:** 2-3 engineering-days
- **Priority:** High --- every storefront and integration consuming our API currently has no compile-time request/response validation

---

## 1. Problem

The existing `@unifiedcommerce/sdk` at `packages/sdk/src/index.ts` is a 678-line hand-written client with two structural deficiencies:

### 1.1 Request Bodies Are Untyped

Every mutation method accepts `JsonObject` (alias for `Record<string, unknown>`):

```typescript
create(body: JsonObject) {
  return request<CommerceApiResponse<CatalogEntity>>("POST", "/api/catalog/entities", { body });
}
```

A caller can pass `{ typo: "product" }` instead of `{ type: "product" }` and TypeScript will not flag the error. The mistake surfaces at runtime as a 422 from the server's Zod validation. This defeats the purpose of having a typed SDK.

### 1.2 Response Types Can Drift

The SDK defines 30+ hand-written interfaces (`CatalogEntity`, `Cart`, `Order`, `Fulfillment`, etc.) that duplicate the shapes defined by the server's Zod schemas. When a column is added to the database schema and the Zod response schema is updated, the SDK interface must be updated manually. If it is not, the SDK returns data that its own types do not describe --- fields exist at runtime that TypeScript does not know about, and consumers cannot access them without casting.

### 1.3 Plugin Routes Are Not Covered

The SDK covers 82 core routes but zero plugin routes. The marketplace plugin has 68 endpoints, the appointments plugin has 31, the POS plugin has additional routes. A storefront integrating with the marketplace or appointment system must fall back to raw `fetch` calls with no type assistance.

### 1.4 The Generator Is a Stub

`packages/sdk/src/generator.ts` produces a route manifest (operation ID + method + path) but does not generate types, request schemas, or response schemas. It was written as scaffolding for a future codegen pipeline that was never built.

---

## 2. Solution: Hybrid Architecture

The SDK will be rebuilt as a two-layer architecture:

**Layer 1 (generated, zero maintenance):** `openapi-typescript` reads the OpenAPI 3.0 JSON spec from `/api/doc` and generates a `paths` type that maps every API path to its request parameters, request body schema, and response body schema. This is the type-level contract. It covers core routes AND plugin routes because the spec includes everything registered via `router()`.

**Layer 2 (hand-written, ergonomic):** A thin wrapper around `openapi-fetch`'s `createClient<paths>()` that groups operations into domain namespaces (`sdk.catalog.list()`, `sdk.cart.addItem()`, etc.). Each wrapper method delegates to the typed path-based client internally. The wrapper adds no logic --- it is purely a DX convenience layer that provides method-based autocomplete instead of URL-path-based autocomplete.

The type safety flows from Layer 1 through Layer 2. If the server adds a field to the response, `openapi-typescript` regenerates the type, and the wrapper method's return type updates automatically. If the server adds a required field to a request body, any caller that omits it gets a compile-time error.

### Why Not `openapi-fetch` Alone

`openapi-fetch`'s raw API is path-based:

```typescript
client.GET("/api/catalog/entities/{idOrSlug}", { params: { path: { idOrSlug: "my-product" } } });
```

This is fully type-safe but ergonomically poor. The developer must know the exact URL path, remember the nesting of `params.path` vs `params.query`, and cannot discover operations via autocomplete on a domain namespace. The wrapper layer solves this:

```typescript
sdk.catalog.get("my-product");
```

Same type safety, better DX. The wrapper is ~200 lines of thin delegation --- trivial to maintain because it contains no logic, only forwarding.

### Why Not a Fully Generated SDK (e.g., `openapi-generator`, `@hey-api/openapi-ts`)

Full codegen tools generate entire client classes with methods, types, and runtime code. They produce 5,000-20,000 lines of generated code that must be checked into the repo or generated in CI. They impose opinions on error handling, pagination, authentication, and serialization that may not align with our patterns. The hybrid approach keeps the generated artifact small (a single `.d.ts` file of type declarations) and keeps runtime code hand-written and auditable.

---

## 3. Architecture

```
                    BUILD TIME                           RUNTIME
               +-----------------+
               |  /api/doc JSON  |
               +--------+--------+
                        |
           openapi-typescript CLI
                        |
                        v
         +-----------------------------+
         |  src/generated/api-types.ts  |      <-- Layer 1: generated types
         |  export type paths = { ... } |          (paths, components, operations)
         +-------------+---------------+
                        |
                        | import type { paths }
                        v
         +-----------------------------+
         |  src/client.ts               |      <-- Layer 2: ergonomic wrapper
         |  export function createSDK() |          (sdk.catalog.list(), sdk.cart.addItem())
         |    -> uses openapi-fetch     |
         +-----------------------------+
                        |
                        | import { createSDK }
                        v
         +-----------------------------+
         |  Consumer code              |
         |  const sdk = createSDK(...) |
         |  sdk.catalog.list()         |
         +-----------------------------+
```

---

## 4. Pseudocode

### 4.1 Type Generation (build time)

```
STEP 1: Fetch the OpenAPI spec from the running server
    spec = HTTP GET "http://localhost:4000/api/doc"
    // Returns OpenAPI 3.0 JSON with all core + plugin routes

STEP 2: Run openapi-typescript to generate TypeScript types
    npx openapi-typescript ./api-spec.json -o src/generated/api-types.ts
    // Produces: export type paths = { "/api/catalog/entities": { get: { ... }, post: { ... } }, ... }
    // Produces: export type components = { schemas: { CatalogEntity: { ... }, Cart: { ... }, ... } }

STEP 3: Commit the generated file
    // The .ts file is checked into the repo so consumers do not need a running server to get types
    // Regenerated when the API changes via: bun run sdk:generate
```

### 4.2 Ergonomic Wrapper (hand-written)

```
FUNCTION createSDK(baseUrl, options?):
    // 1. Create the openapi-fetch client with generated path types
    rawClient = createClient<paths>({ baseUrl, headers: options.headers })

    // 2. If auth token/API key provided, register middleware
    IF options.apiKey:
        rawClient.use(authMiddleware(options.apiKey))

    // 3. Return domain-namespaced wrapper
    RETURN {
        catalog: {
            list(query?):
                RETURN rawClient.GET("/api/catalog/entities", { params: { query } })
                // TypeScript knows: query can have { type?, page?, limit?, status? }
                // TypeScript knows: response is { data: CatalogEntity[] }

            get(idOrSlug, query?):
                RETURN rawClient.GET("/api/catalog/entities/{idOrSlug}", {
                    params: { path: { idOrSlug }, query }
                })
                // TypeScript knows: idOrSlug is string
                // TypeScript knows: response is { data: CatalogEntity }

            create(body):
                RETURN rawClient.POST("/api/catalog/entities", { body })
                // TypeScript knows: body must have { type, slug, ... }
                // TypeScript knows: response is { data: CatalogEntity }
        },

        cart: {
            create(body):
                RETURN rawClient.POST("/api/carts", { body })

            get(cartId):
                RETURN rawClient.GET("/api/carts/{cartId}", { params: { path: { cartId } } })

            addItem(cartId, body):
                RETURN rawClient.POST("/api/carts/{cartId}/items", {
                    params: { path: { cartId } },
                    body,
                })
        },

        // ... same pattern for orders, inventory, pricing, promotions, search, me, webhooks
    }
```

### 4.3 Auth Middleware

```
FUNCTION authMiddleware(credential):
    RETURN {
        onRequest({ request }):
            // API key auth
            IF credential.type == "api_key":
                request.headers.set("x-api-key", credential.key)

            // Bearer token auth (Better Auth session)
            ELSE IF credential.type == "bearer":
                request.headers.set("Authorization", "Bearer " + credential.token)

            // Dev key auth
            ELSE IF credential.type == "dev_key":
                request.headers.set("x-api-key", credential.key)

            RETURN request
    }
```

---

## 5. Code Blueprint

### 5.1 Package Structure

```
packages/sdk/
  package.json
  tsconfig.json
  src/
    index.ts                     -- public API: createSDK, types re-exports
    client.ts                    -- ergonomic wrapper (Layer 2)
    middleware.ts                -- auth middleware for openapi-fetch
    generated/
      api-types.ts               -- openapi-typescript output (Layer 1, committed)
  scripts/
    generate-types.ts            -- fetches /api/doc, runs openapi-typescript
  test/
    sdk.test.ts                  -- unit tests with mock fetch
```

### 5.2 `package.json`

```json
{
  "name": "@unifiedcommerce/sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "check-types": "tsc --noEmit",
    "test": "vitest run",
    "sdk:generate": "bun scripts/generate-types.ts"
  },
  "dependencies": {
    "openapi-fetch": "^0.13.0"
  },
  "devDependencies": {
    "openapi-typescript": "^7.6.0",
    "@porulle/typescript-config": "*",
    "typescript": "5.9.2",
    "vitest": "^3.2.4"
  }
}
```

### 5.3 `scripts/generate-types.ts`

```typescript
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SPEC_URL = process.env.API_URL ?? "http://localhost:4000/api/doc";
const OUTPUT_DIR = join(import.meta.dirname, "../src/generated");
const OUTPUT_FILE = join(OUTPUT_DIR, "api-types.ts");

async function main() {
  // 1. Fetch the live OpenAPI spec
  console.log(`Fetching OpenAPI spec from ${SPEC_URL}...`);
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status}`);
  const spec = await res.json();

  // 2. Write spec to temp file (openapi-typescript reads from file)
  const tmpSpec = join(OUTPUT_DIR, "_spec.json");
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(tmpSpec, JSON.stringify(spec, null, 2));

  // 3. Run openapi-typescript
  console.log(`Generating types to ${OUTPUT_FILE}...`);
  execSync(`npx openapi-typescript ${tmpSpec} -o ${OUTPUT_FILE}`, { stdio: "inherit" });

  // 4. Clean up temp file
  const { unlinkSync } = await import("node:fs");
  unlinkSync(tmpSpec);

  console.log("Done. Types generated at src/generated/api-types.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### 5.4 `src/middleware.ts`

```typescript
import type { Middleware } from "openapi-fetch";

export interface ApiKeyAuth {
  type: "api_key";
  key: string;
}

export interface BearerAuth {
  type: "bearer";
  token: string;
}

export type AuthCredential = ApiKeyAuth | BearerAuth;

export function authMiddleware(credential: AuthCredential): Middleware {
  return {
    onRequest({ request }) {
      if (credential.type === "api_key") {
        request.headers.set("x-api-key", credential.key);
      } else if (credential.type === "bearer") {
        request.headers.set("Authorization", `Bearer ${credential.token}`);
      }
      return request;
    },
  };
}
```

### 5.5 `src/client.ts` (ergonomic wrapper -- Layer 2)

```typescript
import createClient from "openapi-fetch";
import type { paths } from "./generated/api-types";
import { authMiddleware, type AuthCredential } from "./middleware";

export interface SDKOptions {
  baseUrl: string;
  auth?: AuthCredential;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export function createSDK(options: SDKOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    headers: options.headers,
    fetch: options.fetch,
  });

  if (options.auth) {
    client.use(authMiddleware(options.auth));
  }

  return {
    /** Raw openapi-fetch client for paths not covered by the wrapper. */
    raw: client,

    catalog: {
      list(query?: paths["/api/catalog/entities"]["get"]["parameters"]["query"]) {
        return client.GET("/api/catalog/entities", { params: { query } });
      },
      get(idOrSlug: string) {
        return client.GET("/api/catalog/entities/{idOrSlug}", {
          params: { path: { idOrSlug } },
        });
      },
      create(body: paths["/api/catalog/entities"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/catalog/entities", { body });
      },
      update(id: string, body: paths["/api/catalog/entities/{id}"]["patch"]["requestBody"]["content"]["application/json"]) {
        return client.PATCH("/api/catalog/entities/{id}", {
          params: { path: { id } },
          body,
        });
      },
      remove(id: string) {
        return client.DELETE("/api/catalog/entities/{id}", {
          params: { path: { id } },
        });
      },
      publish(id: string) {
        return client.POST("/api/catalog/entities/{id}/publish", {
          params: { path: { id } },
        });
      },
      // ... archive, discontinue, setAttributes, getAttributes,
      //     categories, brands, optionTypes, optionValues, variants
    },

    cart: {
      create(body: paths["/api/carts"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/carts", { body });
      },
      get(cartId: string) {
        return client.GET("/api/carts/{cartId}", {
          params: { path: { cartId } },
        });
      },
      addItem(cartId: string, body: paths["/api/carts/{cartId}/items"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/carts/{cartId}/items", {
          params: { path: { cartId } },
          body,
        });
      },
      updateItem(cartId: string, itemId: string, body: paths["/api/carts/{cartId}/items/{itemId}"]["patch"]["requestBody"]["content"]["application/json"]) {
        return client.PATCH("/api/carts/{cartId}/items/{itemId}", {
          params: { path: { cartId, itemId } },
          body,
        });
      },
      removeItem(cartId: string, itemId: string) {
        return client.DELETE("/api/carts/{cartId}/items/{itemId}", {
          params: { path: { cartId, itemId } },
        });
      },
    },

    checkout: {
      create(body: paths["/api/checkout"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/checkout", { body });
      },
    },

    orders: {
      list(query?: paths["/api/orders"]["get"]["parameters"]["query"]) {
        return client.GET("/api/orders", { params: { query } });
      },
      get(idOrNumber: string) {
        return client.GET("/api/orders/{idOrNumber}", {
          params: { path: { idOrNumber } },
        });
      },
      changeStatus(id: string, body: paths["/api/orders/{id}/status"]["patch"]["requestBody"]["content"]["application/json"]) {
        return client.PATCH("/api/orders/{id}/status", {
          params: { path: { id } },
          body,
        });
      },
      listFulfillments(id: string) {
        return client.GET("/api/orders/{id}/fulfillments", {
          params: { path: { id } },
        });
      },
    },

    inventory: {
      check(query: paths["/api/inventory/check"]["get"]["parameters"]["query"]) {
        return client.GET("/api/inventory/check", { params: { query } });
      },
      adjust(body: paths["/api/inventory/adjust"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/inventory/adjust", { body });
      },
      reserve(body: paths["/api/inventory/reserve"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/inventory/reserve", { body });
      },
      release(body: paths["/api/inventory/release"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/inventory/release", { body });
      },
      createWarehouse(body: paths["/api/inventory/warehouses"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/inventory/warehouses", { body });
      },
      listWarehouses() {
        return client.GET("/api/inventory/warehouses");
      },
    },

    pricing: {
      setBasePrice(body: paths["/api/pricing/prices"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/pricing/prices", { body });
      },
      listPrices(query?: paths["/api/pricing/prices"]["get"]["parameters"]["query"]) {
        return client.GET("/api/pricing/prices", { params: { query } });
      },
      createModifier(body: paths["/api/pricing/modifiers"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/pricing/modifiers", { body });
      },
    },

    promotions: {
      create(body: paths["/api/promotions"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/promotions", { body });
      },
      list() {
        return client.GET("/api/promotions");
      },
      validate(body: paths["/api/promotions/validate"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/promotions/validate", { body });
      },
      deactivate(id: string) {
        return client.POST("/api/promotions/{id}/deactivate", {
          params: { path: { id } },
        });
      },
    },

    search: {
      query(query: paths["/api/search"]["get"]["parameters"]["query"]) {
        return client.GET("/api/search", { params: { query } });
      },
      suggest(query: paths["/api/search/suggest"]["get"]["parameters"]["query"]) {
        return client.GET("/api/search/suggest", { params: { query } });
      },
    },

    webhooks: {
      create(body: paths["/api/webhooks"]["post"]["requestBody"]["content"]["application/json"]) {
        return client.POST("/api/webhooks", { body });
      },
      list() {
        return client.GET("/api/webhooks");
      },
      remove(id: string) {
        return client.DELETE("/api/webhooks/{id}", {
          params: { path: { id } },
        });
      },
    },

    me: {
      profile: {
        get() { return client.GET("/api/me/profile"); },
        update(body: paths["/api/me/profile"]["patch"]["requestBody"]["content"]["application/json"]) {
          return client.PATCH("/api/me/profile", { body });
        },
      },
      addresses: {
        list() { return client.GET("/api/me/addresses"); },
        create(body: paths["/api/me/addresses"]["post"]["requestBody"]["content"]["application/json"]) {
          return client.POST("/api/me/addresses", { body });
        },
        remove(id: string) {
          return client.DELETE("/api/me/addresses/{id}", { params: { path: { id } } });
        },
      },
      orders: {
        list(query?: paths["/api/me/orders"]["get"]["parameters"]["query"]) {
          return client.GET("/api/me/orders", { params: { query } });
        },
        get(idOrNumber: string) {
          return client.GET("/api/me/orders/{idOrNumber}", {
            params: { path: { idOrNumber } },
          });
        },
        tracking(idOrNumber: string) {
          return client.GET("/api/me/orders/{idOrNumber}/tracking", {
            params: { path: { idOrNumber } },
          });
        },
        downloads(orderId: string) {
          return client.GET("/api/me/orders/{orderId}/downloads", {
            params: { path: { orderId } },
          });
        },
        reorder(orderId: string) {
          return client.POST("/api/me/orders/{orderId}/reorder", {
            params: { path: { orderId } },
          });
        },
      },
    },
  };
}
```

### 5.6 `src/index.ts`

```typescript
export { createSDK, type SDKOptions } from "./client";
export { authMiddleware, type AuthCredential, type ApiKeyAuth, type BearerAuth } from "./middleware";
export type { paths, components } from "./generated/api-types";
```

---

## 6. What Gets Deleted

The entire current `src/index.ts` (678 lines) is replaced. Specifically:

- 30+ hand-written interfaces (`CatalogEntity`, `Cart`, `Order`, `Fulfillment`, `Price`, etc.) --- replaced by generated `components["schemas"]` from the OpenAPI spec.
- 82 hand-written method implementations with `JsonObject` body types --- replaced by typed wrapper methods that delegate to `openapi-fetch`.
- `toQueryString()` and `parseResponse()` helper functions --- handled by `openapi-fetch` internally.
- `generator.ts` and `ROUTE_DEFINITIONS` --- no longer needed; types come from the OpenAPI spec directly.

---

## 7. Consumer DX: Before and After

### Before (current SDK)

```typescript
import { createCommerceClient } from "@unifiedcommerce/sdk";

const client = createCommerceClient({
  baseUrl: "http://localhost:4000",
  headers: { "x-api-key": "dev-staff-key" },
});

// No type safety on body --- JsonObject accepts anything
const entity = await client.catalog.create({
  typo: "product",        // <-- no error, this is Record<string, unknown>
  slug: "my-product",
});

// No type safety on response --- hand-written interface may be stale
console.log(entity.data.nonExistentField);   // <-- no error at compile time
```

### After (typed SDK)

```typescript
import { createSDK } from "@unifiedcommerce/sdk";

const sdk = createSDK({
  baseUrl: "http://localhost:4000",
  auth: { type: "api_key", key: "dev-staff-key" },
});

// Full type safety on body --- compile error if field is wrong
const { data, error } = await sdk.catalog.create({
  typo: "product",        // <-- TS error: 'typo' does not exist in type
  slug: "my-product",
});

// Full type safety on response --- generated from actual Zod schemas
if (data) {
  console.log(data.data.id);          // <-- autocomplete works
  console.log(data.data.nonExistent); // <-- TS error: property does not exist
}

// Discriminated error handling
if (error) {
  console.log(error.error.code);      // <-- typed error shape
}

// Plugin routes accessible via raw client
const { data: slots } = await sdk.raw.GET("/api/appointments/availability/{providerId}/slots", {
  params: {
    path: { providerId: "provider-1" },
    query: { date: "2026-03-20", serviceTypeId: "svc-1" },
  },
});
```

---

## 8. Plugin Route Access Strategy

Plugin routes are included in the OpenAPI spec because `router()` generates `RouteConfig` objects registered via `OpenAPIHono.openapi()`. When `openapi-typescript` regenerates types from `/api/doc`, all plugin paths appear in the `paths` type automatically.

For plugin routes, consumers have two options:

**Option A: Use `sdk.raw` (zero maintenance)**

```typescript
const { data } = await sdk.raw.GET("/api/appointments/availability/{providerId}/slots", {
  params: { path: { providerId: "p1" }, query: { date: "2026-03-20", serviceTypeId: "s1" } },
});
```

Full type safety, but path-based DX. No wrapper method needed. Works for all plugins without any SDK changes.

**Option B: Plugin-specific wrapper extension**

A plugin package can export a typed namespace that extends the SDK:

```typescript
// packages/plugins/plugin-appointments/src/sdk.ts
import type { paths } from "@unifiedcommerce/sdk";
import type createClient from "openapi-fetch";

export function appointmentSDK(raw: ReturnType<typeof createClient<paths>>) {
  return {
    services: {
      list() { return raw.GET("/api/appointments/services"); },
      create(body) { return raw.POST("/api/appointments/services", { body }); },
    },
    slots: {
      get(providerId: string, query: { date: string; serviceTypeId: string }) {
        return raw.GET("/api/appointments/availability/{providerId}/slots", {
          params: { path: { providerId }, query },
        });
      },
    },
    // ...
  };
}

// Consumer usage:
const appointments = appointmentSDK(sdk.raw);
const { data } = await appointments.slots.get("provider-1", { date: "2026-03-20", serviceTypeId: "svc-1" });
```

This pattern allows plugin authors to ship ergonomic SDK extensions without modifying the core SDK package.

### Plugin React Hooks

Plugins that ship an ergonomic SDK wrapper (Option B above) can also ship a React hooks wrapper that builds on it. The pattern mirrors the core SDK's Layer 2 / Layer 3 split:

```typescript
// packages/plugins/plugin-appointments/src/sdk-hooks.ts
import type { paths } from "@unifiedcommerce/sdk";
import type createClient from "openapi-fetch";
import type createQueryHooks from "openapi-react-query";

type CommerceHooks = ReturnType<typeof createQueryHooks<paths>>;

export function useAppointmentHooks(commerce: CommerceHooks) {
  return {
    useServices() {
      return commerce.useQuery("get", "/api/appointments/services");
    },

    useSlots(providerId: string, date: string, serviceTypeId: string) {
      return commerce.useQuery("get", "/api/appointments/availability/{providerId}/slots", {
        params: { path: { providerId }, query: { date, serviceTypeId } },
      });
    },

    useMyBookings() {
      return commerce.useQuery("get", "/api/appointments/my-bookings");
    },

    useCreateBooking() {
      return commerce.useMutation("post", "/api/appointments/bookings");
    },

    useCancelBooking() {
      return commerce.useMutation("post", "/api/appointments/bookings/{id}/cancel");
    },

    useRescheduleBooking() {
      return commerce.useMutation("post", "/api/appointments/bookings/{id}/reschedule");
    },
  };
}
```

Consumer usage in a Next.js storefront:

```typescript
import { createSDK } from "@unifiedcommerce/sdk";
import { createCommerceHooks } from "@unifiedcommerce/sdk/react";
import { useAppointmentHooks } from "@unifiedcommerce/plugin-appointments/sdk-hooks";

const sdk = createSDK({ baseUrl: "/api", auth: { type: "api_key", key: "..." } });
const commerce = createCommerceHooks(sdk.raw);
const appointments = useAppointmentHooks(commerce);

function BookingPage({ providerId, serviceTypeId }: Props) {
  const { data: slots, isLoading } = appointments.useSlots(providerId, "2026-03-20", serviceTypeId);
  const createBooking = appointments.useCreateBooking();

  if (isLoading) return <Skeleton />;

  return (
    <div>
      {slots?.data.map((slot) => (
        <button
          key={slot.start}
          onClick={() => createBooking.mutate({
            body: {
              providerId,
              serviceTypeId,
              startTime: slot.start,
              customerName: "John Doe",
              customerEmail: "john@example.com",
              paymentMethod: "cash",
            },
          })}
        >
          {slot.start} - {slot.end}
        </button>
      ))}
    </div>
  );
}
```

### Custom App Route Hooks

Storefront developers follow the same pattern for app-specific routes that are not part of any plugin:

```typescript
// apps/my-store/src/hooks/use-reviews.ts
import type { SDKHooks } from "./sdk-setup";

export function useReviewHooks(commerce: CommerceHooks) {
  return {
    useReviews(entityId: string) {
      return commerce.useQuery("get", "/api/reviews/{entityId}", {
        params: { path: { entityId } },
      });
    },
    useSubmitReview() {
      return commerce.useMutation("post", "/api/reviews");
    },
  };
}
```

The key architectural property: none of these hook factories need to import anything from the core SDK beyond the `paths` type and the `commerce` instance. The type safety flows from the generated OpenAPI types through every layer. If a plugin route changes its response shape, the generated types update, and every hook consumer gets a compile-time error at the point of access --- not a silent runtime mismatch.

---

## 9. Type Generation Workflow

The generated types file (`src/generated/api-types.ts`) is committed to the repository. It is regenerated when the API surface changes.

```
Developer adds/modifies a route
    |
    v
Start server locally (bun run dev)
    |
    v
Run: bun run sdk:generate
    |
    v
openapi-typescript fetches /api/doc → generates api-types.ts
    |
    v
Commit the updated api-types.ts alongside the route change
    |
    v
CI verifies: npx tsc --noEmit (catches any wrapper methods that need updating)
```

If a route is added but the wrapper is not updated, the generated types will have the new path but the wrapper will not expose it. This is acceptable --- the `sdk.raw` client always has full coverage. Wrapper methods are added when the route stabilizes and consumers need the ergonomic API.

If a route changes its request/response shape, the generated types update and any wrapper method that passes incompatible types will produce a compile error. This is the key value of the hybrid approach --- breaking API changes are caught at compile time in the SDK package itself, before they reach consumers.

---

## 10. Implementation Order

| Step | What | Effort |
|------|------|--------|
| 1 | Add `openapi-typescript` and `openapi-fetch` to `packages/sdk/` | 30 min |
| 2 | Write `scripts/generate-types.ts` | 1 hour |
| 3 | Generate initial `api-types.ts` from running server | 30 min |
| 4 | Write `src/middleware.ts` (auth) | 1 hour |
| 5 | Write `src/client.ts` (ergonomic wrapper for all 82 core routes) | 4 hours |
| 6 | Write `src/index.ts` (re-exports) | 30 min |
| 7 | Delete old hand-written interfaces and methods | 30 min |
| 8 | Update `test/sdk.test.ts` with typed assertions | 2 hours |
| 9 | Write `src/react.ts` (openapi-react-query wrapper) | 1 hour |
| 10 | Update docs: new how-to guide `guides/sdk.mdx` | 2 hours |
| 11 | Update docs: `reference/plugins.mdx` SDK section | 1 hour |
| 12 | Verify all consumers still compile | 1 hour |
| **Total** | | **~15 hours (2 days)** |

---

## 11. Success Criteria

- [ ] `bun run sdk:generate` fetches `/api/doc` and produces `src/generated/api-types.ts`
- [ ] `createSDK()` returns a typed client with domain namespaces matching the current SDK API surface
- [ ] Request bodies are compile-time validated: passing a wrong field name produces a TS error
- [ ] Response types are generated from the OpenAPI spec: no hand-written interfaces
- [ ] Plugin routes are accessible via `sdk.raw.GET("/api/appointments/...")`
- [ ] Auth middleware supports API key and Bearer token
- [ ] All existing SDK tests pass (updated to use new API)
- [ ] `npx tsc --noEmit` passes in packages/sdk with zero errors
- [ ] Generated types include marketplace, appointments, and POS plugin routes
- [ ] `createCommerceHooks(sdk.raw)` returns typed TanStack Query hooks for all routes
- [ ] Plugin hook factories (`useAppointmentHooks(commerce)`) work with generated types
- [ ] How-to guide `guides/sdk.mdx` documents: setup, typed requests, plugin hooks, React integration

---

## 12. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| OpenAPI spec missing routes (not all routes use `router()`) | Low | Medium | Audit spec output after generation. Core routes use `OpenAPIHono.openapi()` which auto-registers. |
| `openapi-typescript` generates types that do not match runtime shapes | Very low | High | The types are generated from the same Zod schemas that validate at runtime. Parity is structural. |
| Generated `api-types.ts` is large and slows IDE | Low | Low | File is declaration-only (no runtime code). Modern IDEs handle large `.d.ts` files well. |
| Wrapper methods fall behind when routes are added | Medium | Low | `sdk.raw` provides full coverage. Wrapper is convenience, not correctness. CI catches type mismatches. |
| Breaking change in `openapi-fetch` or `openapi-typescript` | Low | Medium | Pin versions. Both packages are stable (openapi-fetch 0.13.x, openapi-typescript 7.x). |

---

## 13. Optional: React Query Integration

`openapi-react-query` is a companion package from the same `openapi-ts` ecosystem. It wraps `openapi-fetch` in TanStack Query hooks (`useQuery`, `useMutation`, `useSuspenseQuery`) with the same generated `paths` type. Zero additional codegen --- it reads the types from Layer 1.

### Package Export

```
packages/sdk/
  src/
    index.ts          -- createSDK (Node/server/scripts)
    react.ts          -- createCommerceHooks (React/Next.js components)
```

```json
{
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./react": { "types": "./src/react.ts", "default": "./src/react.ts" }
  },
  "dependencies": {
    "openapi-fetch": "^0.13.0",
    "openapi-react-query": "^0.3.0"
  },
  "peerDependencies": {
    "@tanstack/react-query": "^5.0.0"
  }
}
```

### `src/react.ts`

```typescript
import createQueryHooks from "openapi-react-query";
import type createClient from "openapi-fetch";
import type { paths } from "./generated/api-types";

export function createCommerceHooks(client: ReturnType<typeof createClient<paths>>) {
  return createQueryHooks(client);
}
```

### Consumer Usage (Next.js)

```typescript
import { createSDK } from "@unifiedcommerce/sdk";
import { createCommerceHooks } from "@unifiedcommerce/sdk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const sdk = createSDK({ baseUrl: "/api", auth: { type: "api_key", key: "..." } });
const commerce = createCommerceHooks(sdk.raw);
const queryClient = new QueryClient();

// In a client component:
function ProductList() {
  const { data, isLoading, error } = commerce.useQuery("get", "/api/catalog/entities", {
    params: { query: { type: "product", limit: 20 } },
  });

  if (isLoading) return <Skeleton />;
  if (error) return <ErrorMessage error={error} />;

  return data.data.map((product) => <ProductCard key={product.id} product={product} />);
}

// Mutations:
function AddToCartButton({ cartId, variantId }) {
  const addItem = commerce.useMutation("post", "/api/carts/{cartId}/items");

  return (
    <button onClick={() => addItem.mutate({
      params: { path: { cartId } },
      body: { entityId: variantId, quantity: 1 },
    })}>
      Add to Cart
    </button>
  );
}
```

This is additive. Layer 1 and Layer 2 work without React. Layer 3 is for Next.js/React storefronts that want TanStack Query caching, refetching, optimistic updates, and suspense out of the box.

---

## 14. References

- `openapi-typescript` docs: [openapi-ts.dev](https://openapi-ts.dev/)
- `openapi-fetch` docs: [openapi-ts.dev/openapi-fetch](https://openapi-ts.dev/openapi-fetch)
- `openapi-fetch` middleware: [openapi-ts.dev/openapi-fetch/middleware-auth](https://openapi-ts.dev/openapi-fetch/middleware-auth)
- `openapi-react-query` docs: [openapi-ts.dev/openapi-react-query](https://openapi-ts.dev/openapi-react-query)
- Current SDK: `packages/sdk/src/index.ts` (678 lines, 82 routes, `JsonObject` bodies)
- OpenAPI spec endpoint: `GET /api/doc` (JSON), `GET /api/reference` (Swagger UI)
