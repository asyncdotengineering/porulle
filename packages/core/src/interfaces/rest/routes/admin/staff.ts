import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import type { Kernel } from "../../../../runtime/kernel.js";
import type { CommerceConfig } from "../../../../config/types.js";
import type { DrizzleDatabase } from "../../../../kernel/database/drizzle-db.js";
import { member, user, invitation } from "../../../../auth/auth-schema.js";
import { resolveOrgIdForCommerce } from "../../../../auth/org.js";
import { makeId } from "../../../../utils/id.js";
import {
  listStaffRoute,
  createStaffRoute,
  inviteStaffRoute,
  listStaffInvitationsRoute,
  listStaffRolesRoute,
  updateStaffRoleRoute,
  revokeStaffRoute,
} from "../../schemas/admin-staff.js";
import type { Actor } from "../../../../auth/types.js";
import {
  canGrantRole,
  granterForRole,
  isCompositeRole,
  isOwnerRole,
  roleRank,
  validRoles,
} from "../../../../auth/role-authority.js";
import { type AppEnv, requirePerm } from "../../utils.js";

/**
 * Admin staff / RBAC surface (issue #46).
 *
 * Surfaces the Better Auth `member` table as first-class admin REST:
 * list staff, add an existing user with a role, invite by email, change
 * role, revoke — plus the role → permission mapping roles resolve to.
 */
export function adminStaffRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();
  const db = kernel.database.db as DrizzleDatabase;
  const config = kernel.config as CommerceConfig;

  router.use("/staff", requirePerm("staff:manage"));
  router.use("/staff/:id", requirePerm("staff:manage"));
  router.use("/staff/invitations", requirePerm("staff:manage"));
  router.use("/staff/roles", requirePerm("staff:manage"));

  function invalidRole(c: { json: (d: unknown, s: number) => unknown }, role: string) {
    return c.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: `Unknown role "${role}". Valid roles: ${[...validRoles(config)].join(", ")}.`,
        },
      },
      422,
    );
  }

  function rankOf(role: string | null | undefined): number {
    return roleRank(config, role);
  }

  function actorCanGrantRole(actor: Actor | null, targetRole: string): boolean {
    return canGrantRole(
      config,
      actor ? { role: actor.role, permissions: actor.permissions } : null,
      targetRole,
    );
  }

  function insufficientPrivilege(
    c: { json: (d: unknown, s: number) => unknown },
    targetRole: string,
  ) {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: `Cannot assign role "${targetRole}": your role does not have sufficient privilege.`,
        },
      },
      403,
    );
  }

  /**
   * Owners of an organization. Better Auth reads a member's role as a
   * comma-separated list, so a stored `"owner,admin"` is an owner to it; this
   * counts the same way, or the two layers disagree on who the last owner is.
   */
  async function ownerMemberIds(orgId: string): Promise<string[]> {
    const rows = await db
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(eq(member.organizationId, orgId));
    return rows.filter((row) => isOwnerRole(row.role)).map((row) => row.id);
  }

  /**
   * Cancels the member's pending invitations that their role can no longer
   * grant. Acceptance re-checks the inviter's authority too, so this is not
   * what closes the takeover — it keeps the invitation list honest and stops a
   * dead grant sitting there for the rest of its seven-day life.
   *
   * `newRole` is null when the membership is being revoked outright.
   */
  async function cancelUngrantableInvitations(
    orgId: string,
    inviterUserId: string,
    newRole: string | null,
  ): Promise<void> {
    const pending = await db
      .select({ id: invitation.id, role: invitation.role })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, orgId),
          eq(invitation.inviterId, inviterUserId),
          eq(invitation.status, "pending"),
        ),
      );

    const dead = pending.filter(
      (row) =>
        newRole === null ||
        !canGrantRole(config, granterForRole(config, newRole), row.role ?? "member"),
    );

    for (const row of dead) {
      await db
        .update(invitation)
        .set({ status: "canceled" })
        .where(eq(invitation.id, row.id));
    }
  }

  router.openapi(listStaffRoute, async (c) => {
    const orgId = resolveOrgIdForCommerce(c.get("actor"), config);
    const rows = await db
      .select({
        id: member.id,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt,
        email: user.email,
        name: user.name,
      })
      .from(member)
      .leftJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, orgId));
    return c.json({ data: rows });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createStaffRoute, async (c) => {
    const body = c.req.valid("json") as { userId: string; role: string };
    const actor = c.get("actor");
    const orgId = resolveOrgIdForCommerce(actor, config);

    if (isCompositeRole(body.role) || !validRoles(config).has(body.role)) return invalidRole(c, body.role);
    if (!actorCanGrantRole(actor, body.role)) return insufficientPrivilege(c, body.role);

    const users = await db.select().from(user).where(eq(user.id, body.userId));
    if (users.length === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found." } }, 404);
    }

    const existing = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, body.userId)));
    if (existing.length > 0) {
      return c.json(
        { error: { code: "VALIDATION_FAILED", message: "User is already a member of this organization." } },
        422,
      );
    }

    const rows = await db
      .insert(member)
      .values({
        id: makeId(),
        organizationId: orgId,
        userId: body.userId,
        role: body.role,
        createdAt: new Date(),
      })
      .returning();
    return c.json({ data: rows[0] }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(inviteStaffRoute, async (c) => {
    const body = c.req.valid("json") as { email: string; role: string };
    const actor = c.get("actor");
    const orgId = resolveOrgIdForCommerce(actor, config);

    if (isCompositeRole(body.role) || !validRoles(config).has(body.role)) return invalidRole(c, body.role);
    if (!actorCanGrantRole(actor, body.role)) return insufficientPrivilege(c, body.role);
    const rows = await db
      .insert(invitation)
      .values({
        id: makeId(),
        organizationId: orgId,
        email: body.email,
        role: body.role,
        status: "pending",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        inviterId: actor?.userId ?? "system",
      })
      .returning();
    return c.json({ data: rows[0] }, 201);
  });

  router.openapi(listStaffInvitationsRoute, async (c) => {
    const orgId = resolveOrgIdForCommerce(c.get("actor"), config);
    const rows = await db
      .select()
      .from(invitation)
      .where(and(eq(invitation.organizationId, orgId), eq(invitation.status, "pending")));
    return c.json({ data: rows });
  });

  router.openapi(listStaffRolesRoute, async (c) => {
    const roles = config.auth?.roles ?? {};
    const data = Object.entries(roles).map(([role, def]) => ({
      role,
      permissions: def.permissions,
    }));
    return c.json({ data });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateStaffRoleRoute, async (c) => {
    const body = c.req.valid("json") as { role: string };
    const actor = c.get("actor");
    const orgId = resolveOrgIdForCommerce(actor, config);
    const id = c.req.param("id");

    if (isCompositeRole(body.role) || !validRoles(config).has(body.role)) return invalidRole(c, body.role);
    if (!actorCanGrantRole(actor, body.role)) return insufficientPrivilege(c, body.role);

    const rows = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.id, id)));
    const target = rows[0];
    if (!target) {
      return c.json({ error: { code: "NOT_FOUND", message: "Staff member not found." } }, 404);
    }

    // SEC-18/R-02: the actor must also outrank (or equal) the target's CURRENT
    // role, else an admin could demote an owner they do not outrank.
    if (rankOf(actor!.role) < rankOf(target.role)) {
      return insufficientPrivilege(c, target.role);
    }

    if (isOwnerRole(target.role) && !isOwnerRole(body.role) && (await ownerMemberIds(orgId)).length <= 1) {
      return c.json(
        { error: { code: "VALIDATION_FAILED", message: "Cannot demote the organization's last owner." } },
        422,
      );
    }

    const updated = await db
      .update(member)
      .set({ role: body.role })
      .where(eq(member.id, id))
      .returning();
    await cancelUngrantableInvitations(orgId, target.userId, body.role);
    return c.json({ data: updated[0] });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(revokeStaffRoute, async (c) => {
    const actor = c.get("actor");
    const orgId = resolveOrgIdForCommerce(actor, config);
    const id = c.req.param("id");

    const rows = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.id, id)));
    const target = rows[0];
    if (!target) {
      return c.json({ error: { code: "NOT_FOUND", message: "Staff member not found." } }, 404);
    }

    // SEC-18/R-02: the actor must outrank (or equal) the target's current role
    // to revoke it — an admin cannot revoke an owner.
    if (rankOf(actor!.role) < rankOf(target.role)) {
      return insufficientPrivilege(c, target.role);
    }

    if (isOwnerRole(target.role) && (await ownerMemberIds(orgId)).length <= 1) {
      return c.json(
        { error: { code: "VALIDATION_FAILED", message: "Cannot revoke the organization's last owner." } },
        422,
      );
    }

    await db.delete(member).where(eq(member.id, id));
    await cancelUngrantableInvitations(orgId, target.userId, null);
    return c.json({ data: { deleted: true } });
  });

  return router;
}
