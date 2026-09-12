import type { AuthSessionLike, CommerceConfig } from "../config/types.js";
import type { Actor } from "./types.js";
import type { AuthInstance } from "./setup.js";
import { DEFAULT_ORG_ID } from "./org.js";
import { isCredentialRejection } from "./auth-failure.js";

export const AUTH_COOKIE_PREFIX = "uc";
export const SESSION_COOKIE_NAME = `${AUTH_COOKIE_PREFIX}.session_token`;

export const DEFAULT_CUSTOMER_PERMISSIONS = [
  "catalog:read",
  "cart:create",
  "cart:read",
  "cart:update",
  "orders:create",
  "orders:read:own",
  "customers:read:self",
  "customers:update:self",
] as const;

export function getCustomerPermissions(config: CommerceConfig): string[] {
  return config.auth?.customerPermissions ?? [...DEFAULT_CUSTOMER_PERMISSIONS];
}

function resolvePermissions(
  session: AuthSessionLike,
  config: CommerceConfig,
): string[] {
  const role = session.session.activeOrganizationRole;
  if (!role) return getCustomerPermissions(config);
  const roleConfig = config.auth?.roles?.[role];
  return roleConfig ? roleConfig.permissions : [];
}

/**
 * The session's `createdAt` as an ISO string. Better Auth hands it back as a Date
 * from the adapter and as a string over JSON, and an actor crosses both boundaries.
 * A value that is neither is reported as absent rather than as a recent one.
 */
function toIsoString(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Resolve a better-auth session and its porulle organization permissions. */
export async function resolveActor(
  headers: Headers,
  auth: AuthInstance,
  config: CommerceConfig,
  request: Request = new Request("http://localhost", { headers }),
): Promise<Actor | null> {
  let session: AuthSessionLike | null;
  try {
    session = (await auth.api.getSession({
      headers,
    })) as AuthSessionLike | null;
  } catch (err) {
    // A rejected session is anonymous. A session store that could not answer is
    // a fault: reporting it as "no session" downgrades a signed-in caller
    // silently and leaves nothing to debug.
    if (isCredentialRejection(err)) return null;
    throw err;
  }

  if (!session) return null;

  const defaultOrgId = config.auth?.defaultOrganizationId ?? DEFAULT_ORG_ID;
  let role = session.session.activeOrganizationRole as string | undefined;
  let orgId = session.session.activeOrganizationId as string | null;

  if (!role && auth.api.getFullOrganization) {
    try {
      const org = await auth.api.getFullOrganization({
        query: { organizationId: orgId ?? defaultOrgId },
        headers,
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

  if (!role && orgId && auth.api.getActiveMemberRole) {
    try {
      const roleResult = await auth.api.getActiveMemberRole({ headers });
      role = (roleResult as Record<string, unknown>)?.role as
        | string
        | undefined;
    } catch {
      // fall through — treat as customer
    }
  }

  if (!orgId && config.auth?.storeResolver) {
    try {
      const resolved = await config.auth.storeResolver(request);
      if (resolved) orgId = resolved;
    } catch {
      // fall through — use defaultOrgId
    }
  }

  const enrichedSession = {
    ...session,
    session: { ...session.session, activeOrganizationRole: role ?? null },
  };
  return {
    type: "user",
    userId: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? "User",
    vendorId: session.user.vendorId ?? null,
    organizationId: orgId ?? defaultOrgId,
    role: role ?? "customer",
    permissions: resolvePermissions(enrichedSession, config),
    sessionCreatedAt: toIsoString(session.session.createdAt),
  } satisfies Actor;
}
