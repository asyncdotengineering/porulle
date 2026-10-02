import openapiCreateClient from "openapi-fetch";
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
