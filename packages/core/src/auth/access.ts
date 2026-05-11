import type { Actor } from "./types.js";

/**
 * A WhereClause is a plain object representing database filter conditions.
 * The shape mirrors what services and repositories can accept to narrow queries.
 *
 * Example: { customerId: "abc-123" } narrows results to that customer's records.
 * Composite: { or: [{ customerId: "x" }, { organizationId: "y" }] }
 */
export type WhereClause = Record<string, unknown>;

/**
 * AccessResult: the return value of an access function.
 *
 * - `true`: full access, no filter needed
 * - `false`: no access at all
 * - `WhereClause`: partial access — the caller should apply this as a query filter
 */
export type AccessResult = boolean | WhereClause;

/**
 * AccessContext carries everything an access function needs to make a decision.
 *
 * - `actor`: the authenticated user/api-key/null (anonymous)
 * - `data`: the document being accessed (for document-level checks)
 * - `id`: the document ID (when data isn't loaded yet)
 */
export interface AccessContext<TData = unknown> {
  actor: Actor | null;
  data?: TData;
  id?: string;
  req?: Request;
}

/**
 * An AccessFn evaluates access for a given context.
 * Returns boolean (full/no access) or WhereClause (filtered access).
 */
export type AccessFn<TData = unknown> = (
  ctx: AccessContext<TData>,
) => AccessResult | Promise<AccessResult>;

/**
 * Combines multiple WhereClause objects with a logical operator.
 * If there's only one clause, returns it directly (no unnecessary nesting).
 */
function combineWhere(
  queries: WhereClause[],
  operator: "and" | "or",
): WhereClause {
  if (queries.length === 1) return queries[0]!;
  return { [operator]: queries };
}

/**
 * Composes access functions with OR semantics.
 *
 * - If ANY function returns `true`, grants full access immediately (short-circuit).
 * - If one or more return WhereClause, combines them with OR.
 * - If ALL return `false`, denies access.
 *
 * Example:
 * ```typescript
 * const orderReadAccess = accessOR(isAdmin, isDocumentOwner("customerId"))
 * // Admins see all orders; customers see only their own
 * ```
 */
export const accessOR = <TData = unknown>(
  ...fns: Array<AccessFn<TData>>
): AccessFn<TData> => {
  return async (ctx) => {
    const queries: WhereClause[] = [];
    for (const fn of fns) {
      const result = await fn(ctx);
      if (result === true) return true;
      if (result && typeof result === "object") queries.push(result);
    }
    if (queries.length > 0) return combineWhere(queries, "or");
    return false;
  };
};

/**
 * Composes access functions with AND semantics.
 *
 * - If ANY function returns `false`, denies access immediately (short-circuit).
 * - If one or more return WhereClause, combines them with AND.
 * - If ALL return `true`, grants full access.
 *
 * Example:
 * ```typescript
 * const restrictedAccess = accessAND(isAuthenticated, isDocumentOwner("customerId"))
 * // Must be logged in AND own the document
 * ```
 */
export const accessAND = <TData = unknown>(
  ...fns: Array<AccessFn<TData>>
): AccessFn<TData> => {
  return async (ctx) => {
    const queries: WhereClause[] = [];
    for (const fn of fns) {
      const result = await fn(ctx);
      if (result === false) return false;
      if (result !== true && result && typeof result === "object") {
        queries.push(result);
      }
    }
    if (queries.length > 0) return combineWhere(queries, "and");
    return true;
  };
};

/**
 * Switches between two access functions based on a condition.
 *
 * Example:
 * ```typescript
 * const accessByRole = conditional(
 *   ({ actor }) => actor?.role === "vendor",
 *   isDocumentOwner("vendorId"),
 *   isAdmin,
 * )
 * ```
 */
export const conditional = <TData = unknown>(
  condition: ((ctx: AccessContext<TData>) => boolean) | boolean,
  accessFn: AccessFn<TData>,
  fallback: AccessFn<TData> = () => false,
): AccessFn<TData> => {
  return async (ctx) => {
    const applies =
      typeof condition === "function" ? condition(ctx) : condition;
    return applies ? accessFn(ctx) : fallback(ctx);
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Built-in access functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grants access if the actor has admin or owner role (wildcard permissions).
 */
export const isAdmin: AccessFn = ({ actor }) => {
  if (!actor) return false;
  return actor.permissions.includes("*:*");
};

/**
 * Grants access if the actor is authenticated (any role).
 */
export const isAuthenticated: AccessFn = ({ actor }) => {
  return actor != null;
};

/**
 * Returns a WhereClause that filters to documents owned by the actor.
 * The ownerField is the column name that holds the owner's user ID.
 *
 * For document-level checks (when data is provided), returns true/false.
 * For list-level checks (when data is not provided), returns a WhereClause.
 */
export const isDocumentOwner = (
  ownerField = "customerId",
): AccessFn => {
  return ({ actor, data }) => {
    if (!actor) return false;

    // Document-level check: compare directly
    if (data) {
      return (data as Record<string, unknown>)[ownerField] === actor.userId;
    }

    // List-level check: return a filter clause
    return { [ownerField]: actor.userId };
  };
};

/**
 * Grants access to everyone, including anonymous users.
 */
export const publicAccess: AccessFn = () => true;

/**
 * Denies access to everyone.
 */
export const denyAll: AccessFn = () => false;
