import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { member, user } from "../src/auth/auth-schema.js";
import { eq } from "drizzle-orm";

const ownerActor: Actor = {
  ...testActor,
  role: "owner",
  permissions: ["*:*"],
};

const adminActor: Actor = {
  ...testActor,
  role: "admin",
  permissions: ["*:*"],
};

// Issue #46 — the Better Auth member table existed but wasn't surfaced:
// no admin REST to list staff, invite a teammate, assign a role, or revoke.
// /api/admin/staff (+ /invitations, /roles) now exists behind staff:manage.
describe("Issue #46 — admin staff / RBAC REST", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;

    // Seed real user rows (Better Auth would normally create these at signup)
    const db = kernel.database.db;
    await db.insert(user).values([
      { id: testActor.userId, name: "Test Staff", email: "owner@example.com", emailVerified: true },
      { id: "teammate-1", name: "Teammate One", email: "teammate1@example.com", emailVerified: true },
      { id: "teammate-2", name: "Teammate Two", email: "teammate2@example.com", emailVerified: true },
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates a staff member for an existing user, lists them with identity, changes role, revokes", async () => {
    const create = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/admin/staff",
      body: { userId: "teammate-1", role: "manager" },
      actor: testActor,
    });
    expect(create.status).toBe(201);
    const memberRec = (await parseJsonResponse<{ data: any }>(create)).data;
    expect(memberRec.role).toBe("manager");

    const list = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/admin/staff", actor: testActor }),
    );
    const listed = list.data.find((m: any) => m.userId === "teammate-1");
    expect(listed).toBeDefined();
    expect(listed.email).toBe("teammate1@example.com");
    expect(listed.name).toBe("Teammate One");
    expect(listed.role).toBe("manager");

    const patch = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/admin/staff/${memberRec.id}`,
      body: { role: "staff" },
      actor: testActor,
    });
    expect(patch.status).toBe(200);
    expect((await parseJsonResponse<{ data: any }>(patch)).data.role).toBe("staff");

    const del = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/admin/staff/${memberRec.id}`,
      actor: testActor,
    });
    expect(del.status).toBe(200);

    const after = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/admin/staff", actor: testActor }),
    );
    expect(after.data.map((m: any) => m.userId)).not.toContain("teammate-1");
  });

  it("rejects roles that are not defined in the role → permission mapping", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/admin/staff",
      body: { userId: "teammate-2", role: "superhero" },
      actor: testActor,
    });
    expect(res.status).toBe(422);
  });

  it("invites a teammate by email with a role", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/admin/staff/invitations",
      body: { email: "newhire@example.com", role: "manager" },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const invitation = (await parseJsonResponse<{ data: any }>(res)).data;
    expect(invitation.email).toBe("newhire@example.com");
    expect(invitation.role).toBe("manager");
    expect(invitation.status).toBe("pending");
    expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const list = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/admin/staff/invitations", actor: testActor }),
    );
    expect(list.data.map((i: any) => i.email)).toContain("newhire@example.com");
  });

  it("SEC-18: non-owner with staff:manage cannot promote to owner", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/admin/staff",
      body: { userId: "teammate-2", role: "owner" },
      actor: testActor,
    });
    expect(res.status).toBe(403);
  });

  it("SEC-18/R-02: an admin cannot demote or revoke an owner", async () => {
    await kernel.database.db.insert(user).values({
      id: "r02-owner",
      name: "R02 Owner",
      email: "r02-owner@example.com",
      emailVerified: true,
    });
    const create = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/admin/staff",
      body: { userId: "r02-owner", role: "owner" },
      actor: ownerActor,
    });
    expect(create.status).toBe(201);
    const owner = (await parseJsonResponse<{ data: any }>(create)).data;

    // admin (rank < owner) is rejected on rank BEFORE the last-owner guard.
    const demote = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/admin/staff/${owner.id}`,
      body: { role: "admin" },
      actor: adminActor,
    });
    expect(demote.status).toBe(403);

    const revoke = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/admin/staff/${owner.id}`,
      actor: adminActor,
    });
    expect(revoke.status).toBe(403);

    // Clean up the created owner directly (route revoke is blocked by the
    // last-owner guard) so shared state doesn't affect the last-owner test.
    await kernel.database.db.delete(member).where(eq(member.userId, "r02-owner"));
  });

  it("guards against removing or demoting the last owner", async () => {
    const create = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/admin/staff",
      body: { userId: "teammate-2", role: "owner" },
      actor: ownerActor,
    });
    expect(create.status).toBe(201);
    const owner = (await parseJsonResponse<{ data: any }>(create)).data;

    const demote = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/admin/staff/${owner.id}`,
      body: { role: "manager" },
      actor: ownerActor,
    });
    expect(demote.status).toBe(422);

    const revoke = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/admin/staff/${owner.id}`,
      actor: ownerActor,
    });
    expect(revoke.status).toBe(422);
  });

  it("exposes the role → permission mapping", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/admin/staff/roles",
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const roles = (await parseJsonResponse<{ data: any[] }>(res)).data;
    const manager = roles.find((r: any) => r.role === "manager");
    expect(manager).toBeDefined();
    expect(manager.permissions).toContain("orders:update");
    const ownerRole = roles.find((r: any) => r.role === "owner");
    expect(ownerRole.permissions).toContain("*:*");
  });

  it("denies staff management without the staff:manage permission", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/admin/staff",
      actor: { ...testActor, permissions: ["orders:read"] },
    });
    expect(res.status).toBe(403);
  });
});
