import type { Actor } from "../auth/types.js";
import type { CommerceConfig } from "../config/types.js";
import type { Kernel } from "./kernel.js";
import { createKernel } from "./kernel.js";
import { ensureDefaultOrg, setBootDefaultOrgId } from "../auth/org.js";
import { setBootStrictOrgResolution } from "../auth/strict-org-resolution.js";
import { createAuth, type AuthInstance } from "../auth/setup.js";
import { createLogger, type Logger } from "./logger.js";
import { createLocalAPI, type CommerceLocalAPI, type LocalAPIOptions } from "../kernel/local-api.js";

/**
 * The commerce instance returned by `createCommerce()`.
 *
 * This is the headless, framework-agnostic entry point.
 * No HTTP server, no Hono — just typed services and a local API.
 *
 * ## Usage with Next.js App Router:
 *
 * ```typescript
 * // lib/commerce.ts
 * import { createCommerce } from "@porulle/core";
 * import config from "../commerce.config.js";
 *
 * export const commerce = await createCommerce(config);
 *
 * // app/products/page.tsx (Server Component)
 * import { commerce } from "@/lib/commerce";
 *
 * export default async function ProductsPage() {
 *   const products = await commerce.api.catalog.list({ limit: 20 });
 *   if (!products.ok) return <div>Error</div>;
 *   return <ProductGrid items={products.value.items} />;
 * }
 * ```
 *
 * ## Usage with TanStack Start:
 *
 * ```typescript
 * // app/routes/products.tsx
 * import { createServerFn } from "@tanstack/start";
 * import { commerce } from "../lib/commerce.js";
 *
 * const getProducts = createServerFn("GET", async () => {
 *   return commerce.api.catalog.list({ limit: 20 });
 * });
 * ```
 *
 * ## Usage with SvelteKit:
 *
 * ```typescript
 * // src/lib/server/commerce.ts
 * import { createCommerce } from "@porulle/core";
 * import config from "./commerce.config.js";
 * export const commerce = await createCommerce(config);
 *
 * // src/routes/products/+page.server.ts
 * import { commerce } from "$lib/server/commerce";
 * export async function load() {
 *   const products = await commerce.api.catalog.list({ limit: 20 });
 *   return { products: products.ok ? products.value : { items: [] } };
 * }
 * ```
 */
export interface CommerceInstance {
  /** Proxy-based local API — auto-injects actor/tx to every service call */
  api: CommerceLocalAPI;

  /** Raw kernel for advanced usage (hooks, database, config) */
  kernel: Kernel;

  /** Drizzle database instance for direct queries */
  db: unknown;

  /** Auth instance (Better Auth) for session management */
  auth: AuthInstance;

  /** Logger */
  logger: Logger;

  /**
   * Create a scoped API for a specific user/actor.
   * Use this in authenticated routes to scope data access.
   *
   * ```typescript
   * // In a Next.js server action:
   * const userApi = commerce.withActor({
   *   type: "user", userId: session.userId, ...
   * });
   * const orders = await userApi.orders.list({ limit: 10 });
   * // Only returns orders for this user's org
   * ```
   */
  withActor(actor: Actor): CommerceLocalAPI;

  /**
   * Create a scoped API within a database transaction.
   *
   * ```typescript
   * await commerce.kernel.database.transaction(async (tx) => {
   *   const txApi = commerce.withTransaction(tx, actor);
   *   await txApi.inventory.adjust({ entityId, adjustment: -1, reason: "sold" });
   *   await txApi.orders.create({ ... });
   * });
   * ```
   */
  withTransaction(tx: unknown, actor?: Actor | null): CommerceLocalAPI;
}

/**
 * Create a headless commerce instance.
 *
 * This is the primary entry point for using UnifiedCommerce without an HTTP server.
 * It initializes the kernel, database, auth, and returns a local API that works
 * exactly like the REST API but without HTTP overhead.
 *
 * The Hono server (`createServer`) is optional — use it only when you need
 * a standalone HTTP API. For Next.js, TanStack Start, SvelteKit, Nuxt, etc.,
 * use `createCommerce()` directly.
 */
export async function createCommerce(
  config: CommerceConfig,
): Promise<CommerceInstance> {
  const kernel = createKernel(config);

  setBootStrictOrgResolution(config.auth?.strictOrgResolution === true);

  // Register the config-driven org ID so resolveOrgId() can use it
  // without requiring every service to have config access.
  if (config.auth?.defaultOrganizationId) {
    setBootDefaultOrgId(config.auth.defaultOrganizationId);
  } else {
    // Legacy fallback: auto-create org_default for deployments
    // that haven't migrated to seed-based org creation yet.
    await ensureDefaultOrg(kernel.database.db, config.storeName);
  }

  const auth = createAuth(kernel.database, config);
  const logger = createLogger(config);

  // Default API: no actor (public access), no transaction
  const api = createLocalAPI(kernel);

  return {
    api,
    kernel,
    db: kernel.database.db,
    auth,
    logger,

    withActor(actor: Actor): CommerceLocalAPI {
      return createLocalAPI(kernel, { actor });
    },

    withTransaction(tx: unknown, actor?: Actor | null): CommerceLocalAPI {
      return createLocalAPI(kernel, { actor: actor ?? null, tx });
    },
  };
}
