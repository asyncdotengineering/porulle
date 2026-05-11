import openapiCreateClient from "openapi-fetch";
import type { PathsWithMethod, MediaType } from "openapi-typescript-helpers";
import { authMiddleware, type AuthCredential } from "./middleware.js";

export interface SDKOptions {
  /** Base URL of the UnifiedCommerce server (e.g., "http://localhost:4000"). */
  baseUrl: string;
  /** Authentication credential (API key or Bearer token). */
  auth?: AuthCredential | undefined;
  /** Additional headers sent with every request. */
  headers?: Record<string, string> | undefined;
  /** Custom fetch implementation (for testing or SSR). */
  fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Creates a typed openapi-fetch client for your UnifiedCommerce API.
 *
 * Generic — you pass your own generated paths type:
 *
 * ```ts
 * import { createClient } from "@porulle/sdk";
 * import type { paths } from "./generated/api-types";
 *
 * const client = createClient<paths>({
 *   baseUrl: "http://localhost:3000",
 *   auth: { type: "api_key", key: "dev-key" },
 * });
 *
 * const { data } = await client.GET("/api/catalog/entities");
 * ```
 */
export function createClient<TPaths extends {}>(options: SDKOptions) {
  const clientOpts: Parameters<typeof openapiCreateClient<TPaths>>[0] = {
    baseUrl: options.baseUrl,
  };
  if (options.headers) clientOpts.headers = options.headers;
  if (options.fetch) clientOpts.fetch = options.fetch;

  const client = openapiCreateClient<TPaths>(clientOpts);

  if (options.auth) {
    client.use(authMiddleware(options.auth));
  }

  return client;
}

/**
 * Creates a typed SDK with ergonomic domain namespaces.
 *
 * This is a convenience wrapper that creates an openapi-fetch client
 * and adds sdk.catalog.list(), sdk.cart.addItem(), etc. on top.
 *
 * For full type coverage (including plugin routes), use createClient()
 * with your own generated paths type instead.
 *
 * ```ts
 * import { createSDK } from "@porulle/sdk";
 * const sdk = createSDK({ baseUrl: "http://localhost:3000", auth: { ... } });
 * const { data } = await sdk.catalog.list();
 * ```
 */
export function createSDK(options: SDKOptions) {
  const client = openapiCreateClient<Record<string, never>>(
    { baseUrl: options.baseUrl, ...(options.headers ? { headers: options.headers } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) },
  );

  if (options.auth) {
    client.use(authMiddleware(options.auth));
  }

  // Untyped convenience wrappers for core routes.
  // These work without codegen but have no compile-time body/response validation.
  // For full types, use createClient<paths>() with your generated types.
  const raw = client as ReturnType<typeof openapiCreateClient<Record<string, unknown>>>;

  return {
    raw,

    catalog: {
      list(query?: Record<string, string>) { return raw.GET("/api/catalog/entities" as never, query ? { params: { query } } as never : undefined as never); },
      get(idOrSlug: string) { return raw.GET("/api/catalog/entities/{idOrSlug}" as never, { params: { path: { idOrSlug } } } as never); },
      create(body: Record<string, unknown>) { return raw.POST("/api/catalog/entities" as never, { body } as never); },
    },

    cart: {
      create(body: Record<string, unknown>) { return raw.POST("/api/carts" as never, { body } as never); },
      get(id: string) { return raw.GET("/api/carts/{id}" as never, { params: { path: { id } } } as never); },
      addItem(id: string, body: Record<string, unknown>) { return raw.POST("/api/carts/{id}/items" as never, { params: { path: { id } }, body } as never); },
    },

    checkout: {
      create(body: Record<string, unknown>) { return raw.POST("/api/checkout" as never, { body } as never); },
    },

    orders: {
      list(query?: Record<string, string>) { return raw.GET("/api/orders" as never, query ? { params: { query } } as never : undefined as never); },
      get(idOrNumber: string) { return raw.GET("/api/orders/{idOrNumber}" as never, { params: { path: { idOrNumber } } } as never); },
    },

    search: {
      query(query: { q: string; [k: string]: string }) { return raw.GET("/api/search" as never, { params: { query } } as never); },
    },

    me: {
      profile: {
        get() { return raw.GET("/api/me/profile" as never, undefined as never); },
        update(body: Record<string, unknown>) { return raw.PATCH("/api/me/profile" as never, { body } as never); },
      },
      orders: {
        list(query?: Record<string, string>) { return raw.GET("/api/me/orders" as never, query ? { params: { query } } as never : undefined as never); },
        get(id: string) { return raw.GET("/api/me/orders/{id}" as never, { params: { path: { id } } } as never); },
        tracking(id: string) { return raw.GET("/api/me/orders/{id}/tracking" as never, { params: { path: { id } } } as never); },
        reorder(id: string) { return raw.POST("/api/me/orders/{id}/reorder" as never, { params: { path: { id } } } as never); },
      },
    },

    webhooks: {
      list(query?: Record<string, string>) { return raw.GET("/api/webhooks" as never, query ? { params: { query } } as never : undefined as never); },
      get(id: string) { return raw.GET("/api/webhooks/{id}" as never, { params: { path: { id } } } as never); },
      create(body: Record<string, unknown>) { return raw.POST("/api/webhooks" as never, { body } as never); },
      delete(id: string) { return raw.DELETE("/api/webhooks/{id}" as never, { params: { path: { id } } } as never); },
    },
  };
}
