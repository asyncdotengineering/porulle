import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { invitation, member, user } from "../src/auth/auth-schema.js";
import type { CommerceConfig } from "../src/config/types.js";

/**
 * Red-team round 6, breach 2 (`vapt/redteam-rbac-guest-report.md`): a demoted
 * or revoked staff member's outstanding invitations still minted admins and
 * owners. Containment and rank were checked when the invitation was created and
 * never again, so the grant outlived the authority behind it for the
 * invitation's full seven-day life — a complete organization takeover.
 *
 * Acceptance now re-reads the inviter's current membership.
 */

const ORG = "org_default";
const ROLES: NonNullable<NonNullable<CommerceConfig["auth"]>["roles"]> = {
  owner: { permissions: ["*:*"] },
  admin: { permissions: ["*:*"] },
  customer: { permissions: ["catalog:read"] },
};

describe("invitation acceptance re-checks the inviter's authority", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function boot() {
    const config = await createTestConfig({
      auth: { roles: ROLES, requireEmailVerification: false, allowTestActor: true, trustedOrigins: ["http://localhost"] },
    });
    const { app, kernel } = await createServer(config);
    const db = kernel.database.db as any;
    cleanups.push(async () => {});
    return { app, db };
  }

  async function signUp(app: any, email: string): Promise<{ userId: string; cookie: string }> {
    const response = await app.request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email, password: "Round6-Passw0rd!", name: email }),
    });
    expect(response.status).toBe(200);
    const created = (await response.json()) as { user: { id: string } };
    const cookie = response.headers.get("set-cookie") ?? "";
    return { userId: created.user.id, cookie: cookie.split(";")[0] ?? "" };
  }

  async function inviteFrom(
    db: any,
    inviterUserId: string,
    email: string,
    role: string,
  ): Promise<string> {
    const id = `inv-${Math.random().toString(36).slice(2)}`;
    await db.insert(invitation).values({
      id,
      organizationId: ORG,
      email,
      role,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      inviterId: inviterUserId,
    });
    return id;
  }

  async function seatAs(db: any, userId: string, role: string): Promise<void> {
    await db.insert(member).values({
      id: `mem-${userId}`,
      organizationId: ORG,
      userId,
      role,
      createdAt: new Date(),
    });
  }

  function accept(app: any, invitationId: string, cookie: string) {
    return app.request("http://localhost/api/auth/organization/accept-invitation", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", cookie },
      body: JSON.stringify({ invitationId }),
    });
  }

  async function memberRole(db: any, userId: string): Promise<string | undefined> {
    const rows = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, ORG), eq(member.userId, userId)));
    return rows[0]?.role;
  }

  it("refuses an invitation whose inviter has been demoted", async () => {
    const { app, db } = await boot();
    const accompliceEmail = `accomplice-${Date.now()}@test.local`;
    const inviter = await signUp(app, `inviter-${Date.now()}@test.local`);
    const accomplice = await signUp(app, accompliceEmail);
    await seatAs(db, inviter.userId, "owner");

    const invitationId = await inviteFrom(db, inviter.userId, accompliceEmail, "owner");

    // owner2 demotes the inviter; the invitation is still pending.
    await db.update(member).set({ role: "customer" }).where(eq(member.userId, inviter.userId));

    const response = await accept(app, invitationId, accomplice.cookie);
    expect(response.status).toBe(403);
    expect(await memberRole(db, accomplice.userId)).toBeUndefined();

    const [row] = await db.select().from(invitation).where(eq(invitation.id, invitationId));
    expect(row.status).toBe("canceled");
  });

  it("refuses an invitation whose inviter has been revoked entirely", async () => {
    const { app, db } = await boot();
    const accompliceEmail = `guest-${Date.now()}@test.local`;
    const inviter = await signUp(app, `revoked-${Date.now()}@test.local`);
    const accomplice = await signUp(app, accompliceEmail);
    await seatAs(db, inviter.userId, "owner");

    const invitationId = await inviteFrom(db, inviter.userId, accompliceEmail, "admin");
    await db.delete(member).where(eq(member.userId, inviter.userId));

    const response = await accept(app, invitationId, accomplice.cookie);
    expect(response.status).toBe(403);
    expect(await memberRole(db, accomplice.userId)).toBeUndefined();
  });

  it("still accepts an invitation from an inviter who kept their authority", async () => {
    const { app, db } = await boot();
    const inviter = await signUp(app, `keeper-${Date.now()}@test.local`);
    const email = `newstaff-${Date.now()}@test.local`;
    const invited = await signUp(app, email);
    await seatAs(db, inviter.userId, "owner");

    const invitationId = await inviteFrom(db, inviter.userId, email, "admin");

    const response = await accept(app, invitationId, invited.cookie);
    expect(response.status).toBe(200);
    expect(await memberRole(db, invited.userId)).toBe("admin");
  });

  it("holds the invariant whichever of demotion and acceptance lands first", async () => {
    const { app, db } = await boot();
    const inviter = await signUp(app, `race-${Date.now()}@test.local`);
    const email = `racer-${Date.now()}@test.local`;
    const invited = await signUp(app, email);
    await seatAs(db, inviter.userId, "owner");

    const invitationId = await inviteFrom(db, inviter.userId, email, "owner");

    const [demotion, acceptance] = await Promise.all([
      db.update(member).set({ role: "customer" }).where(eq(member.userId, inviter.userId)),
      accept(app, invitationId, invited.cookie),
    ]);
    void demotion;

    const granted = await memberRole(db, invited.userId);
    if (acceptance.status === 200) {
      // Acceptance won: the grant was made while the inviter still held owner.
      expect(granted).toBe("owner");
    } else {
      expect(acceptance.status).toBe(403);
      expect(granted).toBeUndefined();
    }
    // Either way the inviter ends up demoted and no ungoverned grant survives.
    expect(await memberRole(db, inviter.userId)).toBe("customer");
  });

  it("cancels a demoted member's pending invitations they could no longer grant", async () => {
    const { app, db } = await boot();
    const inviter = await signUp(app, `cancel-${Date.now()}@test.local`);
    const coOwner = await signUp(app, `coowner-${Date.now()}@test.local`);
    await seatAs(db, inviter.userId, "owner");
    await seatAs(db, coOwner.userId, "owner");
    const invitationId = await inviteFrom(db, inviter.userId, `x-${Date.now()}@test.local`, "owner");

    const memberRow = await db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.userId, inviter.userId));

    const response = await app.request(
      `http://localhost/api/admin/staff/${memberRow[0].id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "x-test-actor": JSON.stringify({
            type: "user",
            userId: "super",
            email: "super@test.local",
            name: "Super",
            vendorId: null,
            organizationId: ORG,
            role: "owner",
            permissions: ["*:*"],
          }),
        },
        body: JSON.stringify({ role: "customer" }),
      },
    );
    expect(response.status).toBe(200);

    const [row] = await db.select().from(invitation).where(eq(invitation.id, invitationId));
    expect(row.status).toBe("canceled");
  });
});
