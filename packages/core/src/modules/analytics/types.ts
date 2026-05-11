import type { Result } from "../../kernel/result.js";

// ─── Query Params (unchanged from existing API) ─────────────────────────────

export interface AnalyticsTimeDimension {
  dimension: string;
  granularity?: "day" | "week" | "month" | "year";
  dateRange?: [string, string] | string;
}

export interface AnalyticsFilter {
  member: string;
  operator:
    | "equals"
    | "notEquals"
    | "contains"
    | "in"
    | "notIn"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "beforeDate"
    | "afterDate"
    | "inDateRange";
  values?: string[];
}

export interface AnalyticsQueryParams {
  measures: string[];
  dimensions?: string[];
  timeDimensions?: AnalyticsTimeDimension[];
  filters?: AnalyticsFilter[];
  order?: Record<string, "asc" | "desc">;
  limit?: number;
}

// ─── Query Result ────────────────────────────────────────────────────────────

export interface AnalyticsQueryResult {
  query: AnalyticsQueryParams;
  rows: Record<string, unknown>[];
  source: string;
}

// ─── Model / Meta ────────────────────────────────────────────────────────────

export interface AnalyticsModelDefinition {
  name: string;
  measures: string[];
  dimensions: string[];
  segments?: string[];
  source: "builtin" | "plugin" | "custom-schema";
  raw?: unknown;
}

export interface AnalyticsMeta {
  models: AnalyticsModelDefinition[];
  measures: string[];
  dimensions: string[];
  segments: string[];
}

// ─── Analytics Model (declarative SQL mapping) ──────────────────────────────

export type MeasureType = "count" | "sum" | "avg" | "min" | "max" | "countDistinct";

export interface AnalyticsMeasure {
  type: MeasureType;
  /** SQL column or expression (e.g., "grand_total" or "quantity_on_hand * COALESCE(unit_cost, 0)") */
  sql?: string | undefined;
  /** SQL filter expression that must be true for this measure to count a row */
  filter?: string | undefined;
}

export type DimensionType = "string" | "number" | "time" | "boolean";

export interface AnalyticsDimension {
  /** SQL column or expression */
  sql: string;
  type: DimensionType;
}

export interface AnalyticsJoin {
  table: string;
  type: "left" | "inner";
  on: string;
}

export interface AnalyticsModel {
  name: string;
  table: string;
  joins?: AnalyticsJoin[];
  measures: Record<string, AnalyticsMeasure>;
  dimensions: Record<string, AnalyticsDimension>;
  segments?: Record<string, { sql: string }>;
  /**
   * Scope rules define how this model is filtered by role.
   * The filter SQL uses :vendorId or :customerId as placeholders.
   *
   * Example: { role: "vendor", filter: "vendor_id = :vendorId" }
   */
  scopeRules?: AnalyticsScopeRule[];
}

// ─── Scope (Role-Based Query Filtering) ──────────────────────────────────────

export interface AnalyticsScope {
  role: "admin" | "staff" | "vendor" | "customer" | "public";
  vendorId?: string | undefined;
  customerId?: string | undefined;
}

/**
 * Scope rule: defines how an analytics model is filtered for a given role.
 * Registered alongside model definitions.
 */
export interface AnalyticsScopeRule {
  /** Which role this rule applies to */
  role: "vendor" | "customer";
  /** SQL WHERE clause fragment. Use :vendorId or :customerId as placeholders. */
  filter: string;
}

// ─── Scope Builder ───────────────────────────────────────────────────────────

/**
 * Build an AnalyticsScope from an actor (or null for public).
 *
 * This is the ONLY way scopes should be created. Every call site that
 * invokes analytics.query() MUST use this function — never construct
 * a scope manually. This ensures the scope always reflects the
 * authenticated actor's actual role and identity.
 */
export function buildAnalyticsScope(actor: {
  role?: string;
  vendorId?: string | null;
  userId?: string;
} | null): AnalyticsScope {
  if (!actor) return { role: "public" };

  const role = actor.role ?? "public";

  if (role === "admin" || role === "owner" || role === "staff" || role === "ai_agent") {
    return { role: "admin" };
  }

  if (actor.vendorId) {
    return { role: "vendor", vendorId: actor.vendorId };
  }

  if (role === "customer" && actor.userId) {
    return { role: "customer", customerId: actor.userId };
  }

  // Unknown role — deny access
  return { role: "public" };
}

// ─── Adapter Interface ───────────────────────────────────────────────────────

export interface AnalyticsAdapter {
  /** Scope is REQUIRED. Use buildAnalyticsScope(actor) to construct it. */
  query(params: AnalyticsQueryParams, scope: AnalyticsScope): Promise<Result<AnalyticsQueryResult>>;
  getMeta(scope: AnalyticsScope): Promise<Result<AnalyticsMeta>>;
  registerModel(model: AnalyticsModel): void;
}

// ─── Deprecated aliases (remove in next major version) ──────────────────────

/** @deprecated Use AnalyticsModel instead */
export type CubeDefinition = AnalyticsModel;
/** @deprecated Use AnalyticsScopeRule instead */
export type CubeScopeRule = AnalyticsScopeRule;
/** @deprecated Use AnalyticsMeasure instead */
export type MeasureDefinition = AnalyticsMeasure;
/** @deprecated Use AnalyticsDimension instead */
export type DimensionDefinition = AnalyticsDimension;
/** @deprecated Use AnalyticsJoin instead */
export type JoinDefinition = AnalyticsJoin;
