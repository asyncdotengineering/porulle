import type { MiddlewareHandler } from "hono";
import type { AuthSessionLike, CommerceConfig } from "../config/types.js";
import type { Actor } from "./types.js";
import type { AuthInstance } from "./setup.js";
import { DEFAULT_ORG_ID } from "./org.js";
import { isStrictOrgResolution } from "./strict-org-resolution.js";

const DEFAULT_CUSTOMER_PERMISSIONS = [
  "catalog:read",
  "cart:create",
  "cart:read",
  "cart:update",
  "orders:create",
  "orders:read:own",
  "customers:read:self",
  "customers:update:self",
] as const;

function getCustomerPermissions(config: CommerceConfig): string[] {
  return config.auth?.customerPermissions ?? [...DEFAULT_CUSTOMER_PERMISSIONS];
}

const LEGACY_STORE_RESOLVER_WARN_COOLDOWN_MS = 60_000;
let lastLegacyStoreResolverWarnAt = 0;

function resolvePermissions(
  session: AuthSessionLike,
  config: CommerceConfig,
): string[] {
  const role = session.session.activeOrganizationRole;
  if (!role) {
    return getCustomerPermissions(config);
  }
  const roleConfig = config.auth?.roles?.[role];
  return roleConfig ? roleConfig.permissions : [];
}

export function authMiddleware(
  auth: AuthInstance,
  config: CommerceConfig,
): MiddlewareHandler {
  return async (c, next) => {
    // Resolve the default org from config, falling back to deprecated constant
    const defaultOrgId = config.auth?.defaultOrganizationId ?? DEFAULT_ORG_ID;

    // Test-only actor injection: requires NODE_ENV === "test" AND an explicit
    // config opt-in so staging/preview deployments left as NODE_ENV=test do not
    // silently become a full auth bypass.
    if (process.env.NODE_ENV === "test" && config.auth?.allowTestActor) {
      const testActorHeader = c.req.header("x-test-actor");
      if (testActorHeader) {
        try {
          const actor = JSON.parse(testActorHeader) as Actor;
          c.set("actor", actor);
          await next();
          return;
        } catch {
          // Invalid JSON — continue to real auth resolution.
        }
      }
    }

    const session = (await auth.api.getSession({
      headers: c.req.raw.headers,
    })) as AuthSessionLike | null;

    if (session) {
      // Better Auth's session stores activeOrganizationId, but often not the role.
      // For single-store apps (org_default), users may never call set-active,
      // so activeOrganizationId can be null even for valid org members.
      let role = session.session.activeOrganizationRole as string | undefined;
      let orgId = session.session.activeOrganizationId as string | null;

      // If no active org, try to resolve the user's membership in org_default.
      // This handles the common case where the user is a member but hasn't
      // called organization/set-active (single-store apps, seed scripts, tests).
      if (!role && auth.api.getFullOrganization) {
        try {
          const org = await auth.api.getFullOrganization({
            query: { organizationId: orgId ?? defaultOrgId },
            headers: c.req.raw.headers,
          });
          if (org?.members) {
            const membership = org.members.find(
              (m) => m.userId === session.user.id,
            );
            if (membership) {
              role = membership.role;
              orgId = orgId ?? defaultOrgId;
            }
          }
        } catch {
          // fall through — treat as customer
        }
      }

      // Also try getActiveMemberRole if active org is set
      if (!role && orgId && auth.api.getActiveMemberRole) {
        try {
          const roleResult = await auth.api.getActiveMemberRole({
            headers: c.req.raw.headers,
          });
          role = (roleResult as Record<string, unknown>)?.role as string | undefined;
        } catch {
          // fall through — treat as customer
        }
      }

      // For customers without org membership, resolve the store from the request.
      // This enables multi-store SaaS where each storefront is a different org.
      if (!orgId && config.auth?.storeResolver) {
        try {
          const resolved = await config.auth.storeResolver(c.req.raw);
          if (resolved) orgId = resolved;
        } catch {
          // fall through — use defaultOrgId
        }
      }

      const enrichedSession = {
        ...session,
        session: { ...session.session, activeOrganizationRole: role ?? null },
      };
      c.set("actor", {
        type: "user",
        userId: session.user.id,
        email: session.user.email ?? null,
        name: session.user.name ?? "User",
        vendorId: session.user.vendorId ?? null,
        organizationId: orgId ?? defaultOrgId,
        role: role ?? "customer",
        permissions: resolvePermissions(enrichedSession, config),
      } satisfies Actor);
      await next();
      return;
    }

    // Extract API key from headers
    const apiKeyHeader =
      c.req.header("x-api-key") ??
      c.req.header("authorization")?.replace("Bearer ", "");

    if (
      apiKeyHeader &&
      config.auth?.apiKeys?.enabled &&
      auth.api.verifyApiKey
    ) {
      try {
        // Resolve the key's configId from its prefix. Better Auth's apiKey
        // plugin throws "No default api-key configuration found" when named
        // scopes are configured and none is `default`/unset — and verifyApiKey
        // only resolves a named scope (and enforces its configId match) when
        // the configId is forwarded. Match the key's prefix to a configured
        // scope so named-scope keys authenticate instead of silently 401-ing.
        let configId: string | undefined;
        const scopes = config.auth?.apiKeyScopes;
        if (scopes) {
          for (const [scopeId, scope] of Object.entries(scopes)) {
            if (scope.prefix && apiKeyHeader.startsWith(scope.prefix)) {
              configId = scopeId;
              break;
            }
          }
        }

        // Better Auth server-side calls require { body: { ... } } wrapper.
        // Returns { valid, error, key: Omit<ApiKey,"key"> | null }.
        // See: https://better-auth.com/docs/plugins/api-key/reference
        const result = await auth.api.verifyApiKey({
          body: { key: apiKeyHeader, ...(configId ? { configId } : {}) },
        });
        if (result?.valid && result.key) {
          const apiKey = result.key as Record<string, unknown>;

          const name = (apiKey.name ?? "API Key") as string;
          // Read the org (and operator identity) from key metadata when present.
          // POS shift keys carry { organizationId, operatorId } in metadata so the
          // operator is scoped to their store WITHOUT any org membership/role
          // (SEC-16 / R-01). Other keys fall back to the key's organizationId.
          const rawMeta = apiKey.metadata;
          const meta =
            rawMeta && typeof rawMeta === "object"
              ? (rawMeta as Record<string, unknown>)
              : typeof rawMeta === "string"
                ? (() => {
                    try {
                      return JSON.parse(rawMeta) as Record<string, unknown>;
                    } catch {
                      return null;
                    }
                  })()
                : null;
          const metaOrg = typeof meta?.organizationId === "string" ? meta.organizationId : undefined;
          const orgId = (metaOrg ?? apiKey.organizationId ?? defaultOrgId) as string;
          const userId = ((typeof meta?.operatorId === "string" ? meta.operatorId : undefined)
            ?? apiKey.referenceId
            ?? "") as string;

          // Better Auth stores permissions as Record<string, string[]>
          // (e.g. {"catalog":["read","create"]}).  Flatten to the
          // "resource:action" string[] format the engine expects.
          let permissions: string[];
          const rawPerms = apiKey.permissions;
          if (Array.isArray(rawPerms)) {
            permissions = rawPerms;
          } else if (rawPerms && typeof rawPerms === "object") {
            permissions = [];
            for (const [resource, actions] of Object.entries(
              rawPerms as Record<string, string[]>,
            )) {
              for (const action of actions) {
                permissions.push(`${resource}:${action}`);
              }
            }
          } else {
            permissions = config.auth?.apiKeys?.defaultPermissions ?? [];
          }

          c.set("actor", {
            type: "api_key",
            userId,
            email: null,
            name,
            vendorId: null,
            organizationId: orgId,
            role: "api_key",
            permissions,
          } satisfies Actor);
          await next();
          return;
        }
      } catch {
        // invalid, expired, or rate-limited key — fall through
      }
    }

    if (!c.get("actor")) {
      // For anonymous requests in multi-store deployments, resolve the
      // store so catalog/search queries return the right store's data.
      if (config.auth?.storeResolver) {
        try {
          const resolved = await config.auth.storeResolver(c.req.raw);
          if (resolved) {
            // Set a minimal anonymous actor with the resolved org so
            // services can scope queries correctly.
            c.set("actor", {
              type: "user",
              userId: "anonymous",
              email: null,
              name: "Anonymous",
              vendorId: null,
              organizationId: resolved,
              role: "customer",
              permissions: getCustomerPermissions(config),
            } satisfies Actor);
          }
        } catch (err) {
          if (isStrictOrgResolution(config)) {
            const actorCtx = c.get("actor");
            console.error(
              { err, actor: actorCtx ?? null, path: c.req.path, method: c.req.method },
              "storeResolver failed while resolving organization (strict org resolution)",
            );
            const message =
              err instanceof Error ? err.message : String(err);
            return c.json(
              {
                error: {
                  code: "ORG_RESOLUTION_FAILED",
                  message:
                    message || "Organization resolution failed for this request.",
                },
              },
              503,
            );
          }
          const now = Date.now();
          if (now - lastLegacyStoreResolverWarnAt >= LEGACY_STORE_RESOLVER_WARN_COOLDOWN_MS) {
            lastLegacyStoreResolverWarnAt = now;
            console.warn(
              { err, path: c.req.path, method: c.req.method },
              "storeResolver failed; continuing without actor (legacy org resolution)",
            );
          }
        }
      }
      if (!c.get("actor")) {
        c.set("actor", null);
      }
    }
    await next();
  };
}
