import type { Hono, MiddlewareHandler } from "hono";
import type { Actor } from "../auth/types.js";
import type { BeforeHook, AfterHook } from "../kernel/hooks/types.js";
import type { PaymentAdapter } from "../modules/payments/adapter.js";
import type { StorageAdapter } from "../modules/media/adapter.js";
import type { Kernel } from "../runtime/kernel.js";
import type { DatabaseAdapter } from "../kernel/database/adapter.js";
import type { TaxAdapter } from "../modules/tax/adapter.js";
import type { SearchAdapter } from "../modules/search/adapter.js";
import type { JobsAdapter } from "../kernel/jobs/adapter.js";
import type { TaskDefinition } from "../kernel/jobs/types.js";

export interface RoleDefinition {
  permissions: string[];
}

/**
 * Permission scope declared by a plugin manifest.
 * Collected at config resolution and exposed on the kernel and GET /api/admin/permissions.
 */
export interface PluginPermission {
  scope: string;
  description: string;
  /** Set when collected from defineCommercePlugin (the manifest `id`). */
  pluginId?: string;
}

export type FieldType = "text" | "number" | "boolean" | "date" | "json" | "relation" | "select";

export interface EntityFieldDefinition {
  name: string;
  type: FieldType;
  unit?: string;
  schema?: unknown;
  target?: string;
  options?: string[];
}

export interface EntityVariantConfig {
  enabled: boolean;
  optionTypes?: string[];
}

export interface EntityHooks {
  beforeCreate?: BeforeHook<unknown>[];
  afterCreate?: AfterHook<unknown>[];
  beforeUpdate?: BeforeHook<unknown>[];
  afterUpdate?: AfterHook<unknown>[];
  beforeDelete?: BeforeHook<unknown>[];
  afterDelete?: AfterHook<unknown>[];
  /**
   * Runs after global `catalog.beforeRead` hooks. Registered at `catalog.{entityType}.beforeRead`
   * (see kernel entity hook registration). Payload `{ id, slug?, options? }` — `id` is set once the
   * entity row is resolved; hooks may transform `id` / `slug` before hydration.
   */
  beforeRead?: BeforeHook<unknown>[];
  /**
   * Runs after global `catalog.afterRead`. Registered at `catalog.{entityType}.afterRead`.
   * Receives the hydrated entity as `result` (same shape as `catalog.afterRead`).
   */
  afterRead?: AfterHook<unknown>[];
  /**
   * Runs after global `catalog.beforeList` when `filter.type` matches this entity type (after global
   * hooks). Registered at `catalog.{entityType}.beforeList`. Payload matches catalog `list` params:
   * optional `filter`, `sort`, and `pagination`.
   */
  beforeList?: BeforeHook<unknown>[];
  /**
   * Runs after global `catalog.afterList` when the list request’s `filter.type` (after all before-hooks)
   * matches this entity type. Registered at `catalog.{entityType}.afterList`. Payload `result` is
   * `{ items: CatalogEntityHydrated[]; pagination: { page, limit, total, totalPages } }`.
   */
  afterList?: AfterHook<unknown>[];
}

export interface EntityConfig {
  fields: EntityFieldDefinition[];
  variants: EntityVariantConfig;
  fulfillment: string;
  hooks?: EntityHooks;
  /** Optional URL alias. Generates ergonomic CRUD routes at `/api/{alias}` that delegate to the catalog service with `type` pre-injected. E.g., `alias: "products"` creates `GET /api/products`, `POST /api/products`, etc. */
  alias?: string;
}

/**
 * A predefined API key scope — a named set of permissions, prefix, and rate limit.
 * Used with `bunx @porulle/cli api-key create --scope <name>`.
 *
 * Permissions use Better Auth's native format: Record<string, string[]>
 * where keys are resource types and values are arrays of allowed actions.
 */
export interface ApiKeyScopeDefinition {
  /** Prefix for generated keys (e.g., "uc_pub_", "uc_adm_"). */
  prefix: string;
  /** Human description shown in CLI output. */
  description: string;
  /** Permissions in Better Auth format: { catalog: ["read"], orders: ["create", "read"] } */
  permissions: Record<string, string[]>;
  /** Rate limiting for keys created with this scope. */
  rateLimit?: {
    maxRequests: number;
    /** Time window in milliseconds. */
    timeWindow: number;
  };
}

export interface AuthConfig {
  /**
   * The default organization ID for single-store deployments.
   * Created by the seed script via `auth.api.createOrganization()`.
   * Used as fallback when a request has no org context (no session org,
   * no storeResolver match). If not set and no storeResolver is configured,
   * falls back to `"org_default"` with a deprecation warning.
   *
   * @example
   * ```ts
   * defaultOrganizationId: process.env.UC_ORG_ID,
   * ```
   */
  defaultOrganizationId?: string;
  requireEmailVerification?: boolean;
  sessionDuration?: number;
  socialProviders?: Record<string, { clientId: string; clientSecret: string }>;
  twoFactor?: { enabled: boolean; requiredForRoles?: string[] };
  apiKeys?: {
    enabled: boolean;
    /** Default permissions for API keys that don't specify their own. */
    defaultPermissions?: string[];
  };
  posPin?: { enabled: boolean };
  roles?: Record<string, RoleDefinition>;
  customerPermissions?: string[];
  /** Origins allowed for CSRF protection (Better Auth `trustedOrigins`). */
  trustedOrigins?: string[];
  /**
   * Predefined API key scopes. Each scope defines a named permission set
   * that can be used with `bunx @porulle/cli api-key create --scope <name>`.
   *
   * Better Auth's API key plugin is configured with one config per scope.
   */
  apiKeyScopes?: Record<string, ApiKeyScopeDefinition>;
  /**
   * Resolves which organization (store) a request belongs to.
   *
   * Used in multi-store SaaS deployments where each store is a separate
   * organization. The resolver runs when a customer has no org membership
   * (i.e., they're not an admin/staff/vendor).
   *
   * Common patterns:
   * - Header-based: read `x-store-id` header set by the frontend
   * - Domain-based: resolve org from request origin/host
   * - Path-based: extract org slug from URL prefix
   *
   * Single-store and marketplace deployments don't need this — all data
   * is scoped to org_default automatically.
   *
   * @example
   * ```ts
   * storeResolver: async (request) => {
   *   // Header-based: frontend sends x-store-id
   *   const storeId = request.headers.get("x-store-id");
   *   if (storeId) return storeId;
   *
   *   // Domain-based: resolve from origin
   *   const origin = request.headers.get("origin");
   *   if (origin) return await lookupOrgByDomain(origin);
   *
   *   return null; // falls back to org_default
   * }
   * ```
   */
  storeResolver?: (request: Request) => string | null | Promise<string | null>;
  /**
   * When true, a failing `storeResolver` for anonymous requests returns HTTP 503
   * instead of continuing with `actor = null` (legacy). Same behavior when env
   * `STRICT_ORG_RESOLUTION` is `"true"`. Default false keeps backward-compatible
   * fallback for single-store and lenient multi-store setups.
   */
  strictOrgResolution?: boolean;
  /**
   * Phone number OTP authentication via Better Auth's phoneNumber plugin.
   * When configured, users can sign in/up with phone + OTP instead of email/password.
   * You provide the SMS delivery callback; Better Auth handles OTP generation,
   * storage, expiry, brute force protection, and session creation.
   */
  phoneAuth?: {
    /** Send OTP to the phone number. Implement with Twilio, AWS SNS, or any SMS gateway. */
    sendOTP: (params: { phoneNumber: string; code: string }, ctx: unknown) => void | Promise<void>;
    /** Optional custom OTP verification (e.g., Twilio Verify). Overrides internal logic. */
    verifyOTP?: (params: { phoneNumber: string; code: string }, ctx: unknown) => boolean | Promise<boolean>;
    /** OTP length. Default: 6. */
    otpLength?: number;
    /** OTP expiry in seconds. Default: 300 (5 minutes). */
    expiresIn?: number;
    /** Auto-create user on first OTP verification. Default: generates temp email from phone. */
    signUpOnVerification?: {
      getTempEmail: (phoneNumber: string) => string;
      getTempName?: (phoneNumber: string) => string;
    };
  };
  /**
   * Extra Better Auth plugins to inject (e.g., `@better-auth/expo`).
   * Appended to the core plugin list (organization, bearer, jwt, etc.).
   */
  extraAuthPlugins?: unknown[];
}

export interface CartConfig {
  ttlMinutes?: number;
  hooks?: {
    beforeAddItem?: BeforeHook<unknown>[];
    afterAddItem?: AfterHook<unknown>[];
    beforeRemoveItem?: BeforeHook<unknown>[];
    afterRemoveItem?: AfterHook<unknown>[];
    beforeUpdateQuantity?: BeforeHook<unknown>[];
    afterUpdateQuantity?: AfterHook<unknown>[];
  };
}

export interface CheckoutConfig {
  hooks?: {
    beforeCreate?: BeforeHook<unknown>[];
    afterCreate?: AfterHook<unknown>[];
  };
}

export interface OrdersConfig {
  hooks?: {
    beforeCreate?: BeforeHook<unknown>[];
    afterCreate?: AfterHook<unknown>[];
    beforeStatusChange?: BeforeHook<unknown>[];
    afterStatusChange?: AfterHook<unknown>[];
    afterGet?: AfterHook<unknown>[];
    beforeDelete?: BeforeHook<unknown>[];
  };
  /**
   * Extend the order state machine with custom transitions.
   * New states (e.g., "payment_initiated", "shipped", "delivered", "defaulted")
   * are added to the default machine. Existing transitions are preserved.
   * See extendOrderStateMachine() for the merge logic.
   */
  customTransitions?: Record<string, string[]>;
}

export interface InventoryConfig {
  hooks?: {
    afterAdjust?: AfterHook<unknown>[];
  };
}

export interface ShippingConfig {
  type: "flat" | "weight_based";
  flatRate: number;
  freeShippingThreshold?: number;
  brackets: Array<{ upToGrams: number; cost: number }>;
  fallbackCost: number;
}

export interface TaxConfig {
  adapter?: TaxAdapter;
  defaultFromAddress?: {
    country: string;
    postalCode: string;
    state?: string;
    city?: string;
    line1?: string;
  };
}

export interface AnalyticsConfig {
  customSchemaPath?: string;
  models?: unknown[];
}

export interface SearchConfig {
  adapter?: SearchAdapter;
  defaultFacets?: string[];
}

/**
 * A CommercePlugin is a config transform function (PayloadCMS pattern).
 * Receives the current config, returns the modified config.
 * All plugins — simple or complex — are just functions.
 *
 * Use `defineCommercePlugin()` for a structured way to build plugins,
 * or write a raw transform function for full control.
 */
export type CommercePlugin = (
  config: CommerceConfig,
) => CommerceConfig | Promise<CommerceConfig>;

export interface CommerceConfig {
  storeName?: string;
  version?: string;
  database: {
    provider: "postgresql";
    options?: Record<string, unknown>;
  };
  databaseAdapter?: DatabaseAdapter;
  auth?: AuthConfig;
  entities?: Record<string, EntityConfig>;
  cart?: CartConfig;
  checkout?: CheckoutConfig;
  orders?: OrdersConfig;
  inventory?: InventoryConfig;
  shipping?: ShippingConfig;
  payments?: PaymentAdapter[];
  storage?: StorageAdapter;
  media?: {
    allowedMimeTypes?: string[];
    allowSvg?: boolean;
  };
  email?: {
    send(input: {
      template: string;
      to: string;
      data?: Record<string, unknown>;
    }): Promise<void>;
  };
  tax?: TaxConfig;
  analytics?: AnalyticsConfig;
  search?: SearchConfig;
  jobs?: {
    adapter?: JobsAdapter;
    tasks?: TaskDefinition[];
    autorun?: {
      enabled: boolean;
      intervalMs?: number;
    };
  };
  /**
   * Additional Drizzle table definitions — new tables or extended core tables.
   * Each entry is an object of `{ exportName: pgTable(...) }`.
   *
   * These are merged with core schema by `buildSchema(config)` and must also
   * be listed in the app's `drizzle.config.ts` for `db:push` / `db:generate`.
   *
   * Plugins push into this array automatically via `defineCommercePlugin({ schema })`.
   * Apps can also add entries directly — no plugin wrapper needed:
   *
   * ```ts
   * import { reviewsTable } from "./schema/reviews.js";
   * import { extendedProducts } from "./schema/extended-products.js";
   *
   * defineConfig({
   *   schema: [
   *     { reviewsTable },
   *     { extendedProducts },
   *   ],
   *   // ...
   * });
   * ```
   */
  schema?: Array<Record<string, unknown>>;
  /** @internal Merged from `schema` + plugin schemas. Use `schema` instead. */
  customSchemas?: Array<Record<string, unknown>>;
  /**
   * Permission scopes declared by plugins via defineCommercePlugin (`manifest.permissions`).
   * Populated during plugin transforms; each entry includes `pluginId`.
   */
  pluginPermissions?: PluginPermission[];
  hooks?: Record<string, Array<(...args: unknown[]) => unknown>>;
  plugins?: CommercePlugin[];
  middleware?: MiddlewareHandler[];
  routes?: (app: Hono<any>, kernel: Kernel) => void;
  /** Log level for structured logging. Default: "info". */
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  /**
   * Expose the OpenAPI spec (`/api/doc`) and Swagger UI (`/api/reference`).
   * Default: `true` in development, `false` in production.
   */
  exposeOpenApiSpec?: boolean;
  /** Rate limiting overrides. */
  rateLimits?: {
    /** Requests per minute for general API. Default: 100. */
    api?: number;
    /** Requests per minute for auth endpoints. Default: 10. */
    auth?: number;
    /** Requests per minute for checkout. Default: 5. */
    checkout?: number;
    /** Attempts per 15 minutes for sign-in per email. Default: 10. */
    signInPerEmail?: number;
  };
  /**
   * Security header hooks.
   *
   * `default` applies to all responses.
   * `perRoute` overrides by request path. Use exact paths or prefix patterns
   * ending with `*` (for example `/api/checkout/*`).
   */
  security?: {
    csp?: {
      default?: string;
      perRoute?: Record<string, string>;
    };
  };
}

export interface DefineConfigInput extends CommerceConfig {}

export interface AuthSessionLike {
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    vendorId?: string | null;
  };
  session: {
    activeOrganizationId?: string | null;
    activeOrganizationRole?: string | null;
  };
}

export interface KernelFactoryContext {
  config: CommerceConfig;
  actor: Actor | null;
}
