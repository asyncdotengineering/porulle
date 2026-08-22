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
 * Red-team round 6 found that invitation acceptance re-checks nothing: an
 * invitation mints a member at the authority its inviter held up to seven days
 * ago, so a demoted or revoked inviter's outstanding invitation still handed
 * out ownership — a full organization takeover. Acceptance now re-reads the
 * inviter's current authority before the grant is allowed through.
 */

const ORGANIZATION_PREFIX = "/api/auth/organization/";

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
