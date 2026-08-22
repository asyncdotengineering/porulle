import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { member, user } from "../src/auth/auth-schema.js";
import type { Actor } from "../src/auth/types.js";
import { isOwnerRole } from "../src/auth/role-authority.js";

/**
 * Red-team round 6, breach 3 (`vapt/redteam-rbac-guest-report.md`): two owners
 * revoking each other concurrently left the organization with zero owners. The
 * last-owner check was a plain `SELECT` followed by an unconditional write, so
 * both requests read `count = 2` and both proceeded.
 *
 * Note on what these tests can and cannot prove. The suite runs on PGlite, a
 * single-connection Postgres, so `Promise.all` here does not produce genuine
 * interleaving — it proves the invariant holds and the guard still refuses,
 * not that the row lock serialises real concurrent connections. The live
 * Postgres reproduction stays in `vapt/redteam-rbac-guest-probe.ts` (case R10).
 */

const ORG = "org_default";

function ownerActor(userId: string): Actor {
  return {
    type: "user",
    userId,
    email: `${userId}@test.local`,
    name: userId,
    vendorId: null,
    organizationId: ORG,
    role: "owner",
    permissions: ["*:*"],
  } as Actor;
}

describe("last-owner invariant survives concurrent membership writes", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer({
      auth: { roles: { owner: { permissions: ["*:*"] }, customer: { permissions: ["catalog:read"] } } },
    });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    await kernel.database.db.insert(user).values([
      { id: "o1", name: "Owner One", email: "o1@test.local", emailVerified: true },
      { id: "o2", name: "Owner Two", email: "o2@test.local", emailVerified: true },
    ]);
    await kernel.database.db.insert(member).values([
      { id: "mem-o1", organizationId: ORG, userId: "o1", role: "owner", createdAt: new Date() },
      { id: "mem-o2", organizationId: ORG, userId: "o2", role: "owner", createdAt: new Date() },
    ]);
  });

  async function ownerCount(): Promise<number> {
    const rows = await kernel.database.db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.organizationId, ORG));
    return rows.filter((row: { role: string }) => isOwnerRole(row.role)).length;
  }

  it("leaves an owner standing when two owners revoke each other", async () => {
    const [first, second] = await Promise.all([
      makeRequest(server, {
        method: "DELETE",
        url: "http://localhost/api/admin/staff/mem-o2",
        actor: ownerActor("o1"),
      }),
      makeRequest(server, {
        method: "DELETE",
        url: "http://localhost/api/admin/staff/mem-o1",
        actor: ownerActor("o2"),
      }),
    ]);

    expect(await ownerCount()).toBeGreaterThanOrEqual(1);
    const refused = [first, second].filter((r) => r.status !== 200);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.status).toBe(422);
  });

  it("leaves an owner standing when two owners demote each other", async () => {
    const demote = (memberId: string, asUser: string) =>
      makeRequest(server, {
        method: "PATCH",
        url: `http://localhost/api/admin/staff/${memberId}`,
        body: { role: "customer" },
        actor: ownerActor(asUser),
      });

    const [first, second] = await Promise.all([demote("mem-o2", "o1"), demote("mem-o1", "o2")]);

    expect(await ownerCount()).toBeGreaterThanOrEqual(1);
    const refused = [first, second].filter((r) => r.status !== 200);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.status).toBe(422);
  });

  it("still refuses a single request that would remove the last owner", async () => {
    await kernel.database.db.delete(member).where(eq(member.id, "mem-o2"));

    const revoke = await makeRequest(server, {
      method: "DELETE",
      url: "http://localhost/api/admin/staff/mem-o1",
      actor: ownerActor("o1"),
    });
    expect(revoke.status).toBe(422);

    const demote = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/admin/staff/mem-o1",
      body: { role: "customer" },
      actor: ownerActor("o1"),
    });
    expect(demote.status).toBe(422);
    const body = await parseJsonResponse<{ error: { message: string } }>(demote);
    expect(body.error.message).toContain("last owner");
    expect(await ownerCount()).toBe(1);
  });

  it("counts a composite owner role as an owner", async () => {
    await kernel.database.db
      .update(member)
      .set({ role: "owner,admin" })
      .where(eq(member.id, "mem-o2"));
    await kernel.database.db.delete(member).where(eq(member.id, "mem-o1"));

    const revoke = await makeRequest(server, {
      method: "DELETE",
      url: "http://localhost/api/admin/staff/mem-o2",
      actor: ownerActor("o2"),
    });
    expect(revoke.status).toBe(422);
    expect(await ownerCount()).toBe(1);
  });
});
