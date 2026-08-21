import type { CommerceError } from "../../kernel/errors.js";
import { mapErrorToStatus } from "../../kernel/error-mapper.js";
import { toCommerceError } from "../../kernel/errors.js";
import type { Actor } from "../../auth/types.js";

export const ROUTE_PERMISSION_GUARD = Symbol("porulle.routePermissionGuard");

type RouteGuardHandler = {
  [ROUTE_PERMISSION_GUARD]?: { methods?: readonly string[] };
};

export function markRoutePermissionGuard<T>(handler: T, methods?: readonly string[]): T {
  if (typeof handler === "function") {
    Object.defineProperty(handler, ROUTE_PERMISSION_GUARD, { value: { methods } });
  }
  return handler;
}

type PermissionContext = {
  get(key: string): unknown;
  json(data: unknown, status: number): unknown;
  req: { method: string };
};

/**
 * Shared Hono environment type for all sub-routers.
 * Matches the Variables set by middleware in the top-level server app.
 */
export type AppEnv = {
  Variables: {
    actor: Actor | null;
    requestId: string;
    logger: unknown;
    kernel: unknown;
  };
};

const MAX_PAGE_LIMIT = 100;

export function parsePagination(query: Record<string, string | undefined>): {
  page: number;
  limit: number;
} {
  const page = Number.parseInt(query.page ?? "1", 10);
  const limit = Number.parseInt(query.limit ?? "20", 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    limit: Math.min(MAX_PAGE_LIMIT, Number.isFinite(limit) && limit > 0 ? limit : 20),
  };
}

export function parseInclude(value?: string): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/**
 * Map an error to a safe client response. Internal errors are sanitized
 * to prevent leaking SQL, schema, or stack trace details.
 */
export function mapErrorToResponse(error: unknown): { error: { code: string; message: string } } {
  const ce = toCommerceError(error);
  if (ce.code === "INTERNAL_ERROR") {
    // Sanitize internal errors -- do not expose raw messages to clients
    return { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } };
  }
  return { error: { code: ce.code, message: ce.message } };
}

export { mapErrorToStatus };

/**
 * Hono middleware that requires a specific permission on the actor.
 * Returns 401 if no actor, 403 if permission denied.
 * Usage: router.post("/", requirePerm("webhooks:manage"), handler);
 */
export function requirePerm(permission: string) {
  const middleware = async (c: { get(key: string): unknown; json(data: unknown, status: number): unknown }, next: () => Promise<void>) => {
    const actor = c.get("actor") as { permissions?: string[] } | null;
    if (!actor) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }
    const perms = actor.permissions ?? [];
    if (perms.includes(permission) || perms.includes("*:*")) {
      await next();
      return;
    }
    // Check resource-level wildcard (e.g., "catalog:*" matches "catalog:create")
    const [resource] = permission.split(":");
    if (resource && perms.includes(`${resource}:*`)) {
      await next();
      return;
    }
    return c.json({ error: { code: "FORBIDDEN", message: `Permission '${permission}' is required.` } }, 403);
  };
  return markRoutePermissionGuard(middleware);
}

export function requireAnyPerm(permissions: readonly string[]) {
  const middleware = async (c: { get(key: string): unknown; json(data: unknown, status: number): unknown }, next: () => Promise<void>) => {
    const actor = c.get("actor") as { permissions?: string[] } | null;
    const granted = actor?.permissions ?? [];
    const allowed = permissions.some((permission) =>
      granted.includes(permission) ||
      granted.includes("*:*") ||
      granted.includes(`${permission.split(":")[0]}:*`),
    );
    if (!actor) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }
    if (allowed) {
      await next();
      return;
    }
    return c.json({ error: { code: "FORBIDDEN", message: `One of these permissions is required: ${permissions.join(", ")}.` } }, 403);
  };
  return markRoutePermissionGuard(middleware);
}

export function requireMethodPerm(methods: readonly string[], permission: string) {
  const permissionGuard = requirePerm(permission);
  const middleware = async (c: PermissionContext, next: () => Promise<void>) => {
    if (!methods.includes(c.req.method)) {
      await next();
      return;
    }
    return permissionGuard(c, next);
  };
  return markRoutePermissionGuard(middleware, methods);
}

export function isRoutePermissionGuard(handler: unknown, method?: string): boolean {
  if (typeof handler !== "function") return false;
  const guard = (handler as unknown as RouteGuardHandler)[ROUTE_PERMISSION_GUARD];
  return Boolean(guard && (!method || !guard.methods || guard.methods.includes(method)));
}

export function parseSort(
  value?: string,
):
  | {
  field: "createdAt" | "updatedAt" | "slug";
  direction: "asc" | "desc";
}
  | undefined {
  if (!value) return undefined;
  const [fieldRaw, directionRaw] = value.split(":");
  const selectedField = fieldRaw ?? "createdAt";
  const field = ["createdAt", "updatedAt", "slug"].includes(selectedField)
    ? (selectedField as "createdAt" | "updatedAt" | "slug")
    : "createdAt";
  const direction = directionRaw === "asc" ? "asc" : "desc";
  return { field, direction };
}

export function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
