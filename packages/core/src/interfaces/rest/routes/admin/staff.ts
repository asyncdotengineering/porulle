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
   * Runs a membership mutation with the organization's member rows locked, so
   * the last-owner check and the write it guards cannot be interleaved.
   *
   * Counting owners and then mutating as two statements let two owners revoke
   * each other concurrently: both read `count = 2`, both proceed, and the
   * organization is left with none. The lock makes the second transaction
   * re-read after the first commits, so it sees the count it must respect.
   *
   * The whole member set is locked, not just the owner rows, because an owner
   * is any member whose role string contains `owner` — a predicate SQL cannot
   * express as cheaply as the JS filter below. Membership writes are rare
   * administrative actions, so serialising them per organization is free.
   * `ORDER BY id` fixes the lock order and keeps two concurrent revocations
   * from deadlocking each other.
   */
  async function withMembershipLock<T>(
    orgId: string,
    run: (tx: DrizzleDatabase, ownerIds: string[]) => Promise<T>,
  ): Promise<T> {
    return kernel.database.transaction(async (raw) => {
      const tx = raw as DrizzleDatabase;
      const locked = await tx
        .select({ id: member.id, role: member.role })
        .from(member)
        .where(eq(member.organizationId, orgId))
        .orderBy(member.id)
        .for("update");
      const ownerIds = locked
        .filter((row) => isOwnerRole(row.role))
        .map((row) => row.id);
      return run(tx, ownerIds);
    });
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

    const outcome = await withMembershipLock(orgId, async (tx, ownerIds) => {
      const rows = await tx
        .select()
        .from(member)
        .where(and(eq(member.organizationId, orgId), eq(member.id, id)));
      const target = rows[0];
      if (!target) return { kind: "not-found" } as const;

      // SEC-18/R-02: the actor must also outrank (or equal) the target's CURRENT
      // role, else an admin could demote an owner they do not outrank.
      if (rankOf(actor!.role) < rankOf(target.role)) {
        return { kind: "outranked", role: target.role } as const;
      }

      if (isOwnerRole(target.role) && !isOwnerRole(body.role) && ownerIds.length <= 1) {
        return { kind: "last-owner" } as const;
      }

      const updated = await tx
        .update(member)
        .set({ role: body.role })
        .where(eq(member.id, id))
        .returning();
      return { kind: "updated", target, row: updated[0] } as const;
    });

    if (outcome.kind === "not-found") {
      return c.json({ error: { code: "NOT_FOUND", message: "Staff member not found." } }, 404);
    }
    if (outcome.kind === "outranked") return insufficientPrivilege(c, outcome.role);
    if (outcome.kind === "last-owner") {
      return c.json(
        { error: { code: "VALIDATION_FAILED", message: "Cannot demote the organization's last owner." } },
        422,
      );
    }

    await cancelUngrantableInvitations(orgId, outcome.target.userId, body.role);
    return c.json({ data: outcome.row });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(revokeStaffRoute, async (c) => {
    const actor = c.get("actor");
    const orgId = resolveOrgIdForCommerce(actor, config);
    const id = c.req.param("id");

    const outcome = await withMembershipLock(orgId, async (tx, ownerIds) => {
      const rows = await tx
        .select()
        .from(member)
        .where(and(eq(member.organizationId, orgId), eq(member.id, id)));
      const target = rows[0];
      if (!target) return { kind: "not-found" } as const;

      // SEC-18/R-02: the actor must outrank (or equal) the target's current role
      // to revoke it — an admin cannot revoke an owner.
      if (rankOf(actor!.role) < rankOf(target.role)) {
        return { kind: "outranked", role: target.role } as const;
      }

      if (isOwnerRole(target.role) && ownerIds.length <= 1) {
        return { kind: "last-owner" } as const;
      }

      await tx.delete(member).where(eq(member.id, id));
      return { kind: "deleted", target } as const;
    });

    if (outcome.kind === "not-found") {
      return c.json({ error: { code: "NOT_FOUND", message: "Staff member not found." } }, 404);
    }
    if (outcome.kind === "outranked") return insufficientPrivilege(c, outcome.role);
    if (outcome.kind === "last-owner") {
      return c.json(
        { error: { code: "VALIDATION_FAILED", message: "Cannot revoke the organization's last owner." } },
        422,
      );
    }

    await cancelUngrantableInvitations(orgId, outcome.target.userId, null);
    return c.json({ data: { deleted: true } });
  });

  return router;
}
