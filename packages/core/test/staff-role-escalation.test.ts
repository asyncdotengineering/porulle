import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import type { CommerceConfig } from "../src/config/types.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";
import { member, user } from "../src/auth/auth-schema.js";
import { eq } from "drizzle-orm";

const escalationRoles: NonNullable<CommerceConfig["auth"]>["roles"] = {
  owner: { permissions: ["*:*"] },
  admin: { permissions: ["*:*"] },
  curator: { permissions: ["staff:manage"] },
  superops: { permissions: ["*:*"] },
  clerk: { permissions: ["orders:read"] },
  // Elevated but WITHOUT `*:*`, so it ranks as an ordinary custom role. The
  // `*:*` floor in roleRank cannot refuse it; only permission containment can.
  // Without this fixture the escalation tests pass under the old rank rule too,
  // and prove nothing about containment.
  shadowops: {
    permissions: ["staff:manage", "orders:*", "catalog:*", "inventory:adjust"],
  },
};

const curatorActor: Actor = {
  ...testActor,
  userId: "curator-user",
  role: "curator",
  permissions: ["staff:manage"],
};

const adminActor: Actor = {
  ...testActor,
  userId: "admin-user",
  role: "admin",
  permissions: ["*:*"],
};

const superopsActor: Actor = {
  ...testActor,
  userId: "superops-user",
  role: "superops",
  permissions: ["*:*"],
};

const ownerActor: Actor = {
  ...testActor,
  userId: "owner-user",
  role: "owner",
  permissions: ["*:*"],
};

const divergentClerkActor: Actor = {
  ...testActor,
  userId: "divergent-clerk-user",
  role: "clerk",
  permissions: ["staff:manage", "orders:read"],
};

describe("staff role escalation — permission containment", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer({
      auth: { roles: escalationRoles },
    });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;

    const db = kernel.database.db;
    await db.insert(user).values([
      { id: "curator-user", name: "Curator", email: "curator@example.com", emailVerified: true },
      { id: "target-user", name: "Target", email: "target@example.com", emailVerified: true },
      { id: "superops-user", name: "Super Ops", email: "superops@example.com", emailVerified: true },
      { id: "owner-user", name: "Owner", email: "owner@example.com", emailVerified: true },
      { id: "admin-user", name: "Admin", email: "admin@example.com", emailVerified: true },
      { id: "divergent-target-user", name: "Divergent Target", email: "divergent-target@example.com", emailVerified: true },
    ]);

    await db.insert(member).values([
      {
        id: "member-curator",
        organizationId: "org_default",
        userId: "curator-user",
        role: "curator",
        createdAt: new Date(),
      },
      {
        id: "member-target",
        organizationId: "org_default",
        userId: "target-user",
        role: "clerk",
        createdAt: new Date(),
      },
      {
        id: "member-superops",
        organizationId: "org_default",
        userId: "superops-user",
        role: "superops",
        createdAt: new Date(),
      },
      {
        id: "member-divergent-target",
        organizationId: "org_default",
        userId: "divergent-target-user",
        role: "clerk",
        createdAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  // The discriminative case for containment. `shadowops` carries no `*:*`, so it
  // ranks 1 exactly like `curator`; the old `rank >= rank` rule permitted this
  // grant and the `*:*` rank floor does not catch it. Only containment refuses.
  it("rejects a curator granting shadowops, which outranks nothing but holds more permissions", async () => {
    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-target",
      body: { role: "shadowops" },
      actor: curatorActor,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a curator self-promoting to shadowops", async () => {
    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-curator",
      body: { role: "shadowops" },
      actor: curatorActor,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a curator granting a custom *:* role because it is above the actor's rank", async () => {
    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-target",
      body: { role: "superops" },
      actor: curatorActor,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a curator self-promoting to a custom *:* role because it is above the actor's rank", async () => {
    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-curator",
      body: { role: "superops" },
      actor: curatorActor,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a curator inviting superops", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/admin/staff/invitations",
      body: { email: "sock@puppet.test", role: "superops" },
      actor: curatorActor,
    });
    expect(res.status).toBe(403);
  });

  it("rejects an admin granting owner because the new role is higher-ranked", async () => {
    try {
      const res = await makeRequest(server, {
        method: "PATCH",
        url: "http://localhost/api/admin/staff/member-target",
        body: { role: "owner" },
        actor: adminActor,
      });
      expect(res.status).toBe(403);
    } finally {
      await kernel.database.db
        .update(member)
        .set({ role: "clerk" })
        .where(eq(member.id, "member-target"));
    }
  });

  // Pins the CURRENT-role guard, not the new-role floor: the target already
  // holds `owner` (rank 3) and superops floors at admin (rank 2), so the
  // refusal comes from `roleRank(actor) < roleRank(target.role)`.
  // The counterpart, and the behaviour the changeset now states plainly: a custom
  // `*:*` role CAN grant `admin`. It is floored at admin rank on purpose — that
  // floor is what stops a lesser role revoking it — and containment holds, since
  // `*:*` covers `*:*`. Granting `admin` hands out nothing the minter lacks, and
  // `owner` stays unreachable at rank 3. Without this test the false claim that
  // superops cannot grant admin could be reintroduced with the suite still green.
  it("allows a superops actor to grant admin to a lower-ranked member", async () => {
    await kernel.database.db.insert(member).values({
      id: "member-superops-grants-admin-ok",
      organizationId: "org_default",
      userId: "target-user",
      role: "clerk",
      createdAt: new Date(),
    });

    try {
      const res = await makeRequest(server, {
        method: "PATCH",
        url: "http://localhost/api/admin/staff/member-superops-grants-admin-ok",
        body: { role: "admin" },
        actor: superopsActor,
      });
      expect(res.status).toBe(200);
    } finally {
      await kernel.database.db
        .delete(member)
        .where(eq(member.id, "member-superops-grants-admin-ok"));
    }
  });

  it("rejects a superops actor acting on an owner, because the target outranks it", async () => {
    await kernel.database.db.insert(member).values({
      id: "member-superops-grant-admin",
      organizationId: "org_default",
      userId: "owner-user",
      role: "owner",
      createdAt: new Date(),
    });

    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-superops-grant-admin",
      body: { role: "admin" },
      actor: superopsActor,
    });
    expect(res.status).toBe(403);

    await kernel.database.db.delete(member).where(eq(member.id, "member-superops-grant-admin"));
  });

  it("judges containment by the actor's permissions rather than its role config", async () => {
    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-divergent-target",
      body: { role: "curator" },
      actor: divergentClerkActor,
    });
    expect(res.status).toBe(200);
    expect((await parseJsonResponse<{ data: { role: string } }>(res)).data.role).toBe("curator");
  });

  it("rejects a curator granting clerk because orders:read is not contained by staff:manage", async () => {
    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-target",
      body: { role: "clerk" },
      actor: curatorActor,
    });
    expect(res.status).toBe(403);
  });

  it("allows an admin to grant superops", async () => {
    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-target",
      body: { role: "superops" },
      actor: adminActor,
    });
    expect(res.status).toBe(200);
    expect((await parseJsonResponse<{ data: { role: string } }>(res)).data.role).toBe("superops");
  });

  it("rejects an admin demoting an owner (rank protection on current role)", async () => {
    await kernel.database.db.insert(member).values({
      id: "member-rank-owner",
      organizationId: "org_default",
      userId: "owner-user",
      role: "owner",
      createdAt: new Date(),
    });

    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-rank-owner",
      body: { role: "admin" },
      actor: adminActor,
    });
    expect(res.status).toBe(403);

    await kernel.database.db.delete(member).where(eq(member.id, "member-rank-owner"));
  });

  it("rejects a curator revoking a superops member (*:* floors at admin rank)", async () => {
    const res = await makeRequest(server, {
      method: "DELETE",
      url: "http://localhost/api/admin/staff/member-superops",
      actor: curatorActor,
    });
    expect(res.status).toBe(403);
  });

  it("returns 422 when demoting the last owner", async () => {
    await kernel.database.db.insert(member).values({
      id: "member-last-owner",
      organizationId: "org_default",
      userId: "owner-user",
      role: "owner",
      createdAt: new Date(),
    });

    const res = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/member-last-owner",
      body: { role: "admin" },
      actor: ownerActor,
    });
    expect(res.status).toBe(422);

    await kernel.database.db.delete(member).where(eq(member.id, "member-last-owner"));
  });
});
