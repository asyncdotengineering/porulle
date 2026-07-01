import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import type { Kernel } from "../../../../runtime/kernel.js";
import type { CommerceConfig } from "../../../../config/types.js";
import type { DrizzleDatabase } from "../../../../kernel/database/drizzle-db.js";
import { member, user, invitation } from "../../../../auth/auth-schema.js";
import { resolveOrgId } from "../../../../auth/org.js";
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

  function validRoles(): Set<string> {
    return new Set([
      ...Object.keys(config.auth?.roles ?? {}),
      "owner",
      "admin",
      "member",
    ]);
  }

  function invalidRole(c: { json: (d: unknown, s: number) => unknown }, role: string) {
    return c.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: `Unknown role "${role}". Valid roles: ${[...validRoles()].join(", ")}.`,
        },
      },
      422,
    );
  }

  async function countOwners(orgId: string): Promise<number> {
    const rows = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")));
    return rows.length;
  }

  router.openapi(listStaffRoute, async (c) => {
    const orgId = resolveOrgId(c.get("actor"));
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
    const orgId = resolveOrgId(c.get("actor"));

    if (!validRoles().has(body.role)) return invalidRole(c, body.role);

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
    const orgId = resolveOrgId(actor);

    if (!validRoles().has(body.role)) return invalidRole(c, body.role);

    const rows = await db
      .insert(invitation)
      .values({
        id: makeId(),
        organizationId: orgId,
        email: body.email,
        role: body.role,
        status: "pending",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        inviterId: actor!.userId,
      })
      .returning();
    return c.json({ data: rows[0] }, 201);
  });

  router.openapi(listStaffInvitationsRoute, async (c) => {
    const orgId = resolveOrgId(c.get("actor"));
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
    const orgId = resolveOrgId(c.get("actor"));
    const id = c.req.param("id");

    if (!validRoles().has(body.role)) return invalidRole(c, body.role);

    const rows = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.id, id)));
    const target = rows[0];
    if (!target) {
      return c.json({ error: { code: "NOT_FOUND", message: "Staff member not found." } }, 404);
    }

    if (target.role === "owner" && body.role !== "owner" && (await countOwners(orgId)) <= 1) {
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
    return c.json({ data: updated[0] });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(revokeStaffRoute, async (c) => {
    const orgId = resolveOrgId(c.get("actor"));
    const id = c.req.param("id");

    const rows = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.id, id)));
    const target = rows[0];
    if (!target) {
      return c.json({ error: { code: "NOT_FOUND", message: "Staff member not found." } }, 404);
    }

    if (target.role === "owner" && (await countOwners(orgId)) <= 1) {
      return c.json(
        { error: { code: "VALIDATION_FAILED", message: "Cannot revoke the organization's last owner." } },
        422,
      );
    }

    await db.delete(member).where(eq(member.id, id));
    return c.json({ data: { deleted: true } });
  });

  return router;
}
