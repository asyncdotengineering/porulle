import type { MiddlewareHandler } from "hono";
import type { Actor } from "../../auth/types.js";
import { createHookContext } from "../../kernel/hooks/create-context.js";
import type { ServiceContainer } from "../../kernel/hooks/types.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import type { Kernel } from "../../runtime/kernel-types.js";

/**
 * Hono context variables a handler can set to override the audit defaults.
 * Add to your app's Env Variables to get type-safe `c.set(...)` calls.
 */
export interface AuditVars {
  /** Override the derived event name. */
  auditEvent: string;
  /** Override the audit payload (defaults to `{}`). */
  auditPayload: Record<string, unknown>;
  /** Override the derived entity type. */
  auditEntityType: string;
  /** Override the derived entity id. */
  auditEntityId: string;
  /** Set to skip the audit write for this request entirely. */
  auditSkip: boolean;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_RE_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** First non-`api` path segment, normalized (e.g. `/api/pos/customers/...` → `pos`). */
function deriveEntityType(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const start = segments[0] === "api" ? 1 : 0;
  return segments[start] ?? "unknown";
}

/**
 * Middleware that writes exactly one `commerce_audit_log` row per successful
 * (2xx) state-changing request, so every porulle app gets audit-by-default
 * without per-route boilerplate.
 *
 * ```ts
 * app.use("*", auditMiddleware(kernel));
 * ```
 *
 * Handlers may override the derived defaults via context variables
 * (see {@link AuditVars}):
 *
 * ```ts
 * c.set("auditEvent", "refund.manager_override");
 * c.set("auditEntityType", "order");
 * c.set("auditEntityId", orderId);
 * c.set("auditSkip", true); // opt out
 * ```
 *
 * Behavior:
 * - GET/HEAD/OPTIONS and non-2xx responses never write a row.
 * - entityId derivation: handler override → first UUID in the path →
 *   `data.id` peeked from the JSON response body → `"n/a"`.
 * - event default: `<verb>:<path-with-uuids-as-:id>`.
 * - Writes are best-effort — a failed audit write never affects the response.
 */
export function auditMiddleware(kernel: Kernel): MiddlewareHandler {
  return async (c, next) => {
    await next();

    const method = c.req.method.toUpperCase();
    if (!MUTATING.has(method)) return;

    const status = c.res.status;
    if (status < 200 || status >= 300) return;

    if (c.get("auditSkip") === true) return;

    const path = c.req.path;
    const event =
      (c.get("auditEvent") as string | undefined) ??
      `${method.toLowerCase()}:${path.replace(UUID_RE_GLOBAL, ":id")}`;
    const entityType =
      (c.get("auditEntityType") as string | undefined) ?? deriveEntityType(path);
    const payload = (c.get("auditPayload") as Record<string, unknown> | undefined) ?? {};

    let entityId =
      (c.get("auditEntityId") as string | undefined) ?? path.match(UUID_RE)?.[0];
    if (!entityId) {
      // Peek the response body (a clone — the original stream is untouched).
      try {
        const body = (await c.res.clone().json()) as { data?: { id?: unknown } };
        if (typeof body?.data?.id === "string") entityId = body.data.id;
      } catch {
        // non-JSON / empty body — fall through to "n/a"
      }
    }
    entityId ??= "n/a";

    try {
      const requestId = c.get("requestId") as string | undefined;
      const ctx = createHookContext({
        actor: (c.get("actor") as Actor | null) ?? null,
        ...(requestId ? { requestId } : {}),
        logger: kernel.logger,
        services: kernel.services as unknown as ServiceContainer,
        database: { db: kernel.database.db as unknown as PluginDb },
        origin: "rest",
      });
      await kernel.services.audit.record({ entityType, entityId, event, payload, ctx });
    } catch {
      // Best-effort: a transient audit-write failure must not bubble to the response.
    }
  };
}
