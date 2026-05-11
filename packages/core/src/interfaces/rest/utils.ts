import type { CommerceError } from "../../kernel/errors.js";
import { mapErrorToStatus } from "../../kernel/error-mapper.js";
import { toCommerceError } from "../../kernel/errors.js";
import type { Actor } from "../../auth/types.js";

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
  return async (c: { get(key: string): unknown; json(data: unknown, status: number): unknown }, next: () => Promise<void>) => {
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
