import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import type { CommerceConfig } from "../config/types.js";
import type { DrizzleDatabase } from "../kernel/database/drizzle-db.js";
import { invitation, member } from "./auth-schema.js";
import { canGrantRole, granterForRole, isCompositeRole } from "./role-authority.js";

/**
 * Guards Better Auth's organization endpoints, which this repository mounts but
 * does not govern.
 *
 * Red-team round 6 found two problems behind that mount.
 *
 * Invitation acceptance re-checked nothing: an invitation minted a member at
 * the authority its inviter held up to seven days ago, so a demoted or revoked
 * inviter's outstanding invitation still handed out ownership — a full
 * organization takeover. Acceptance now re-reads the inviter's current
 * authority before the grant is allowed through.
 *
 * And the plugin's own membership writers are a second role-changing surface
 * running none of the rules `admin/staff.ts` enforces: no permission
 * containment, no rank floor, no last-owner invariant, and they accept
 * comma-composite role strings that `admin/staff.ts` refuses. They are refused
 * here. `admin/staff.ts` is this repository's governed membership surface, and
 * having one is worth more than making two of them agree.
 */

const ORGANIZATION_PREFIX = "/api/auth/organization/";

/**
 * Better Auth endpoints that write membership or define what a role may do.
 *
 * `invite-member` currently throws for every role instead of refusing: the
 * plugin is configured with commerce permission arrays where its access-control
 * model expects `Role` objects exposing `.authorize()`, so its permission check
 * dies of type confusion. That is fail-closed by accident, and the accident is
 * one "fix the roles wiring" commit away from being fail-open. Refusing here
 * makes the closure deliberate, so repairing that wiring cannot quietly open an
 * ungoverned door. `update-member-role` is not even inert today — Better Auth
 * short-circuits it for organization creators, so an owner reaches it.
 */
const REFUSED_ENDPOINTS = new Set([
  "invite-member",
  "update-member-role",
  "remove-member",
  "leave",
  "create-role",
  "update-role",
  "delete-role",
]);

function endpointName(path: string): string | null {
  const normalized = path.replace(/\/+$/, "");
  return normalized.startsWith(ORGANIZATION_PREFIX)
    ? normalized.slice(ORGANIZATION_PREFIX.length)
    : null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.clone().json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function organizationGuard(
  db: DrizzleDatabase,
  config: CommerceConfig,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }

    const endpoint = endpointName(c.req.path);
    if (endpoint === null) {
      await next();
      return;
    }

    if (REFUSED_ENDPOINTS.has(endpoint)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `"${endpoint}" is not a governed membership surface. Use /api/admin/staff, which enforces permission containment, the rank floor, and the last-owner invariant.`,
          },
        },
        403,
      );
    }

    if (endpoint !== "accept-invitation") {
      await next();
      return;
    }

    const body = await readJsonBody(c.req.raw);
    const invitationId = typeof body.invitationId === "string" ? body.invitationId : null;
    if (!invitationId) {
      await next();
      return;
    }

    const rows = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, invitationId));
    const pending = rows[0];
    // Missing, already-answered, or expired invitations are Better Auth's own
    // error surface — do not duplicate its messages here.
    if (!pending || pending.status !== "pending") {
      await next();
      return;
    }

    const invitedRole = pending.role ?? "member";
    const inviterRows = await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, pending.organizationId),
          eq(member.userId, pending.inviterId),
        ),
      );
    const inviterRole = inviterRows[0]?.role;

    const stillAuthorized =
      inviterRole !== undefined &&
      !isCompositeRole(invitedRole) &&
      canGrantRole(config, granterForRole(config, inviterRole), invitedRole);

    if (stillAuthorized) {
      await next();
      return;
    }

    // The grant is dead: burn it rather than leaving it to be retried.
    await db
      .update(invitation)
      .set({ status: "canceled" })
      .where(and(eq(invitation.id, invitationId), eq(invitation.status, "pending")));

    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message:
            "This invitation is no longer valid: the member who sent it can no longer grant that role.",
        },
      },
      403,
    );
  };
}
