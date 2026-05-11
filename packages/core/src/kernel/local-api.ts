import type { Actor } from "../auth/types.js";
import type { Kernel } from "../runtime/kernel.js";
import type { TxContext } from "./database/tx-context.js";

/**
 * Proxy-based Local API — the Payload-style programmatic interface.
 *
 * Exposes services registered on `kernel.services` without hardcoding method
 * signatures. Uses a Proxy to intercept property access and wrap each service
 * method to auto-inject `actor` and `txCtx`.
 *
 * ## Usage in Next.js / TanStack Start / SvelteKit:
 *
 * ```typescript
 * import { createCommerce } from "@porulle/core";
 * import config from "./commerce.config.js";
 *
 * const commerce = await createCommerce(config);
 *
 * // Server action / loader — no HTTP round-trip
 * const products = await commerce.api.catalog.list({ limit: 10 });
 * const order = await commerce.api.orders.getById("order-123");
 * ```
 *
 * Plugin services are NOT exposed on `commerce.api`. Plugins instantiate their
 * own services inside `routes(ctx)` via `ctx.services`. A
 * future enhancement (backlog B-03) will introduce plugin service registration
 * into the typed `kernel.services` map.
 *
 * ## Usage from a hook:
 *
 * ```typescript
 * const api = createLocalAPI(kernel, { actor, tx });
 * const product = await api.catalog.getById("prod-123");
 * ```
 *
 * ## How it works:
 *
 * 1. `api.catalog` → Proxy intercepts, finds `kernel.services.catalog`
 * 2. `api.catalog.getById(id)` → Proxy intercepts method call
 * 3. Wraps the call: `kernel.services.catalog.getById(id, actor, txCtx)`
 * 4. Returns the result directly — no HTTP, no serialization
 *
 * The Proxy auto-appends `actor` and `txCtx` to every method call.
 * Service methods that accept `(actor, ctx)` as the last two params
 * get them injected automatically. Methods that don't accept them
 * still work — extra args are harmlessly ignored by JavaScript.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for creating a local API instance */
export interface LocalAPIOptions {
  actor?: Actor | null;
  tx?: unknown;
  requestId?: string;
}

/**
 * Maps a service type to strip actor/txCtx params from each method.
 * Plugin authors get clean autocomplete: `api.catalog.create(input)`
 * instead of `api.catalog.create(input, actor, txCtx)`.
 */
type CleanService<T> = {
  [K in keyof T]: T[K] extends (...args: infer _A) => infer R
    ? (...args: unknown[]) => R
    : T[K];
};

/** The full local API type — all kernel services with cleaned signatures */
export type CommerceLocalAPI<
  TServices extends Record<string, unknown> = Kernel["services"],
> = {
  [K in keyof TServices]: TServices[K] extends Record<string, unknown>
    ? CleanService<TServices[K]>
    : TServices[K];
};

// ─── Implementation ─────────────────────────────────────────────────────────

const SERVICE_METHOD_CACHE = new WeakMap<object, Map<string, Function>>();

/**
 * Create a proxy-based local API over kernel services.
 * Every service method gets `actor` and `txCtx` auto-injected.
 */
export function createLocalAPI(
  kernel: Kernel,
  options: LocalAPIOptions = {},
): CommerceLocalAPI {
  const actor = options.actor ?? null;
  const txCtx: TxContext | undefined =
    options.tx != null
      ? ({
          tx: options.tx,
          actor,
          requestId: options.requestId ?? crypto.randomUUID(),
        } as TxContext)
      : undefined;

  // Top-level proxy: intercept service access (e.g., api.catalog, api.giftCards)
  // The Proxy transforms method signatures at runtime (auto-injecting actor/txCtx),
  // so the cast from Kernel["services"] to CommerceLocalAPI is safe.
  return new Proxy(kernel.services as CommerceLocalAPI, {
    get(target, serviceName: string) {
      const service = (target as Record<string, unknown>)[serviceName];

      // Non-object services (e.g., email config) — return as-is
      if (service == null || typeof service !== "object") {
        return service;
      }

      // Method-level proxy: intercept method calls on the service
      return new Proxy(service, {
        get(svcTarget, methodName: string) {
          const method = (svcTarget as Record<string, unknown>)[methodName];

          if (typeof method !== "function") {
            return method;
          }

          // Check cache to avoid re-creating wrapper functions
          let methodCache = SERVICE_METHOD_CACHE.get(svcTarget as object);
          if (!methodCache) {
            methodCache = new Map();
            SERVICE_METHOD_CACHE.set(svcTarget as object, methodCache);
          }

          const cacheKey = `${methodName}:${actor?.userId ?? "null"}`;
          let cached = methodCache.get(cacheKey);
          if (cached) return cached;

          // Create wrapped method that auto-injects actor + txCtx
          cached = (...args: unknown[]) => {
            return (method as Function).call(svcTarget, ...args, actor, txCtx);
          };

          methodCache.set(cacheKey, cached);
          return cached;
        },
      });
    },
  });
}

// ─── Legacy Class API (backward compat) ─────────────────────────────────────

/**
 * @deprecated Use `createLocalAPI(kernel, { actor, tx })` instead.
 * Kept for backward compatibility with existing hook code.
 */
export class LocalAPI {
  private _proxy: CommerceLocalAPI;

  constructor(
    ctx: { actor: Actor | null; tx: unknown; requestId: string },
    kernel: Kernel,
  ) {
    this._proxy = createLocalAPI(kernel, {
      actor: ctx.actor,
      tx: ctx.tx,
      requestId: ctx.requestId,
    });
  }

  get orders() { return this._proxy.orders; }
  get catalog() { return this._proxy.catalog; }
  get cart() { return this._proxy.cart; }
  get inventory() { return this._proxy.inventory; }
  get customers() { return this._proxy.customers; }
  get pricing() { return this._proxy.pricing; }
  get promotions() { return this._proxy.promotions; }
  get media() { return this._proxy.media; }
  get shipping() { return this._proxy.shipping; }
  get search() { return this._proxy.search; }
  get webhooks() { return this._proxy.webhooks; }
  get fulfillment() { return this._proxy.fulfillment; }
  get payments() { return this._proxy.payments; }
  get analytics() { return this._proxy.analytics; }
  get tax() { return this._proxy.tax; }
  get audit() { return this._proxy.audit; }
  get organization() { return this._proxy.organization; }

  /** Resolve a service by name from `kernel.services`. */
  service(name: string) {
    return (this._proxy as Record<string, unknown>)[name];
  }
}
