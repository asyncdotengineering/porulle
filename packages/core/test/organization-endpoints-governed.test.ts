import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { member, user } from "../src/auth/auth-schema.js";
import { isOwnerRole, roleRank, validRoles } from "../src/auth/role-authority.js";
import type { CommerceConfig } from "../src/config/types.js";

/**
 * Red-team round 6 asked whether Better Auth's own organization endpoints were
 * held by its default admin roles. They were not: `auth/setup.ts` hands the
 * plugin commerce permission arrays where its access-control model expects
 * `Role` objects, so `invite-member` threw for every role — fail-closed by type
 * confusion — while `update-member-role` reached 200 for an owner, because the
 * plugin short-circuits creators before the broken check.
 *
 * That made it a fourth role-changing path running none of `admin/staff.ts`'s
 * rules, and one "fix the roles wiring" commit away from being live. The
 * decision recorded here: those endpoints are refused. This test is what stops
 * a later repair from silently reopening them.
 */

const ORG = "org_default";
const ROLES: NonNullable<NonNullable<CommerceConfig["auth"]>["roles"]> = {
  owner: { permissions: ["*:*"] },
  admin: { permissions: ["*:*"] },
  customer: { permissions: ["catalog:read"] },
};

describe("Better Auth's organization endpoints are not a second membership surface", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function boot() {
    const config = await createTestConfig({
      auth: {
        roles: ROLES,
        requireEmailVerification: false,
        allowTestActor: true,
        defaultOrganizationId: ORG,
      },
    });
    const { app, kernel } = await createServer(config);
    return { app, db: kernel.database.db as any, config };
  }

  async function signIn(app: any, email: string): Promise<{ userId: string; cookie: string }> {
    const response = await app.request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email, password: "Round6-Passw0rd!", name: email }),
    });
    expect(response.status).toBe(200);
    const created = (await response.json()) as { user: { id: string } };
    return {
      userId: created.user.id,
      cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    };
  }

  function post(app: any, endpoint: string, body: unknown, cookie: string) {
    return app.request(`http://localhost/api/auth/organization/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", cookie },
      body: JSON.stringify(body),
    });
  }

  it("refuses every membership writer, including for an owner", async () => {
    const { app, db } = await boot();
    const owner = await signIn(app, `ba-owner-${Date.now()}@test.local`);
    await db.insert(member).values({
      id: `mem-${owner.userId}`,
      organizationId: ORG,
      userId: owner.userId,
      role: "owner",
      createdAt: new Date(),
    });

    const target = await signIn(app, `ba-target-${Date.now()}@test.local`);
    await db.insert(member).values({
      id: `mem-${target.userId}`,
      organizationId: ORG,
      userId: target.userId,
      role: "customer",
      createdAt: new Date(),
    });

    const attempts: Array<[string, unknown]> = [
      ["update-member-role", { memberId: `mem-${target.userId}`, role: "owner", organizationId: ORG }],
      ["invite-member", { email: "someone@test.local", role: "owner", organizationId: ORG }],
      ["remove-member", { memberIdOrEmail: `mem-${target.userId}`, organizationId: ORG }],
      ["leave", { organizationId: ORG }],
    ];

    for (const [endpoint, body] of attempts) {
      const response = await post(app, endpoint, body, owner.cookie);
      expect(response.status, endpoint).toBe(403);
    }

    const rows = await db.select({ role: member.role }).from(member).where(eq(member.userId, target.userId));
    expect(rows[0]?.role).toBe("customer");
  });

  it("refuses a composite role string that Better Auth would have accepted", async () => {
    const { app, db } = await boot();
    const owner = await signIn(app, `ba-comp-${Date.now()}@test.local`);
    await db.insert(member).values({
      id: `mem-${owner.userId}`,
      organizationId: ORG,
      userId: owner.userId,
      role: "owner",
      createdAt: new Date(),
    });
    const target = await signIn(app, `ba-comptarget-${Date.now()}@test.local`);
    await db.insert(member).values({
      id: `mem-${target.userId}`,
      organizationId: ORG,
      userId: target.userId,
      role: "customer",
      createdAt: new Date(),
    });

    const viaPlugin = await post(
      app,
      "update-member-role",
      { memberId: `mem-${target.userId}`, role: "owner,admin", organizationId: ORG },
      owner.cookie,
    );
    expect(viaPlugin.status).toBe(403);

    const viaStaff = await app.request(`http://localhost/api/admin/staff/mem-${target.userId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        "x-test-actor": JSON.stringify({
          type: "user",
          userId: owner.userId,
          email: "owner@test.local",
          name: "Owner",
          vendorId: null,
          organizationId: ORG,
          role: "owner",
          permissions: ["*:*"],
        }),
      },
      body: JSON.stringify({ role: "owner,admin" }),
    });
    expect(viaStaff.status).toBe(422);
  });

  it("agrees with Better Auth on what counts as an owner", async () => {
    const { config } = await boot();

    // Better Auth reads a member's role as a comma-separated list, so every
    // one of these is an owner to it. Commerce must not disagree.
    for (const role of ["owner", "owner,admin", "admin,owner"]) {
      expect(isOwnerRole(role)).toBe(true);
      expect(roleRank(config, role)).toBe(roleRank(config, "owner"));
    }
    expect(isOwnerRole("coowner")).toBe(false);
    expect(isOwnerRole("admin")).toBe(false);
    expect(validRoles(config).has("owner,admin")).toBe(false);
  });
});
