import type { AuthSessionLike, CommerceConfig } from "../config/types.js";
import type { Actor } from "./types.js";
import type { AuthInstance } from "./setup.js";
import { DEFAULT_ORG_ID } from "./org.js";
import { isCredentialRejection } from "./auth-failure.js";

/**
 * The slice of Better Auth's internal context this file uses. Declared here
 * rather than imported because `$context` is not on the public `Auth` type; if a
 * future Better Auth removes or renames it, `findMembershipRole` degrades to
 * "no role" rather than throwing, and the membership tests fail loudly.
 */
interface AuthContextLike {
  adapter?: {
    findOne<T>(query: {
      model: string;
      where: { field: string; value: unknown }[];
    }): Promise<T | null>;
  };
}

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

/**
 * The caller's role in one organization, by one indexed read of `member`.
 *
 * This used to go through the organization plugin's endpoints, and that cost six
 * statements instead of one. `getFullOrganization` loads the organization row,
 * its invitations and its ENTIRE member list, then scans in JavaScript for a
 * single membership; `getActiveMemberRole` then looks for the same membership
 * again. Both take `headers` and re-resolve the session from them, so each also
 * re-reads `session` and `user`, and the plugin writes `active_organization_id`
 * back to the session row — a write on the hot path of every GET.
 *
 * For a shopper every one of those is a guaranteed miss: a shopper is not a
 * member of the platform organization and never will be. The member-by-
 * organization scan also grows with the member list, so the platform's busiest
 * request got slower as the platform got bigger.
 *
 * The adapter read below is the same query the plugin ended with, issued once
 * and without re-resolving anything. `findOne` returning null IS the answer for
 * a shopper — one miss, done.
 */
async function findMembershipRole(
  auth: AuthInstance,
  userId: string,
  organizationId: string,
): Promise<string | undefined> {
  try {
    const context = await (
      auth as unknown as { $context?: Promise<AuthContextLike> }
    ).$context;
    const membership = await context?.adapter?.findOne<{ role?: string }>({
      model: "member",
      where: [
        { field: "userId", value: userId },
        { field: "organizationId", value: organizationId },
      ],
    });
    return membership?.role;
  } catch {
    // A membership that cannot be read is not a role. Treated as customer, as
    // the plugin-endpoint version was, so this stays a performance change.
    return undefined;
  }
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

  if (!role) {
    role = await findMembershipRole(auth, session.user.id, orgId ?? defaultOrgId);
    if (role) orgId = orgId ?? defaultOrgId;
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
