/**
 * React Query integration for the UnifiedCommerce SDK.
 *
 * Wraps any openapi-fetch client in TanStack Query hooks.
 * Generic — works with any generated paths type.
 *
 * @example
 * ```typescript
 * import { createClient } from "@porulle/sdk";
 * import { createCommerceHooks } from "@porulle/sdk/react";
 * import type { paths } from "./generated/api-types";
 *
 * const client = createClient<paths>({ baseUrl: "http://localhost:3000" });
 * const commerce = createCommerceHooks(client);
 *
 * function ProductList() {
 *   const { data } = commerce.useQuery("get", "/api/catalog/entities", {
 *     params: { query: { type: "product" } },
 *   });
 * }
 * ```
 */

import createQueryHooks from "openapi-react-query";
import type createOpenapiClient from "openapi-fetch";

/**
 * Creates TanStack Query hooks from any typed openapi-fetch client.
 *
 * @param client - A typed openapi-fetch client (from createClient<paths>())
 * @returns useQuery, useMutation, useSuspenseQuery hooks typed against your paths
 */
export function createCommerceHooks<TPaths extends {}>(
  client: ReturnType<typeof createOpenapiClient<TPaths>>,
) {
  return createQueryHooks(client);
}

/** Type alias for the hooks object returned by createCommerceHooks. */
export type CommerceHooks<TPaths extends {} = {}> = ReturnType<typeof createCommerceHooks<TPaths>>;
