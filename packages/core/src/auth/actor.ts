import type { AuthSessionLike, CommerceConfig } from "../config/types.js";
import type { Actor } from "./types.js";
import type { AuthInstance } from "./setup.js";
import { DEFAULT_ORG_ID } from "./org.js";

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
  } catch {
    return null;
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
  } satisfies Actor;
}
