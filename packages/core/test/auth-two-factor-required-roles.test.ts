import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/index.js";
import { authMiddleware } from "../src/auth/middleware.js";
import { member, user } from "../src/auth/auth-schema.js";
import type { AuthInstance } from "../src/auth/setup.js";
import { createAuth } from "../src/auth/setup.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

/**
 * `auth.twoFactor.requiredForRoles` is documented as making two-factor
 * authentication mandatory for those roles. A signed-in member holding a listed
 * role who has not enabled 2FA must be refused — not served with that role's
 * permissions — and must be told why, so they can go enrol.
 */
describe("auth.twoFactor.requiredForRoles", () => {
  let cleanup: () => Promise<void>;
  let auth: AuthInstance;
  let db: DrizzleDatabase;
  let probe: Hono<{ Variables: { actor: Actor | null } }>;

  const authApp = () => {
    const app = new Hono();
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    return app;
  };

  async function signedInMember(role: string): Promise<{ cookie: string; userId: string }> {
    const email = `tfa-${role.replace(/[^a-z]/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
    const headers = { "content-type": "application/json", origin: "http://localhost" };
    const signUp = await authApp().request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password: "TestPassword123!", name: `TFA ${role}` }),
    });
    expect(signUp.status).toBe(200);
    const { user: created } = (await signUp.json()) as { user: { id: string } };
    await db.insert(member).values({
      id: `member-${created.id}`,
      organizationId: "org_default",
      userId: created.id,
      role,
      createdAt: new Date(),
    });
    const signIn = await authApp().request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password: "TestPassword123!" }),
    });
    expect(signIn.status).toBe(200);
    const sessionCookie = (signIn.headers.get("set-cookie") ?? "").split(", ")[0]!.split(";")[0]!;
    expect(sessionCookie.startsWith("uc.session_token=")).toBe(true);
    return { cookie: sessionCookie, userId: created.id };
  }

  async function probeAs(cookie: string): Promise<Response> {
    return probe.request("http://localhost/probe", { headers: { cookie } });
  }

  beforeAll(async () => {
    const harness = await createPGliteTestConfig({
      auth: {
        defaultOrganizationId: "org_default",
        requireEmailVerification: false,
        trustedOrigins: ["http://localhost"],
        twoFactor: { enabled: true, requiredForRoles: ["owner"] },
        roles: {
          owner: { permissions: ["*:*"] },
          staff: { permissions: ["catalog:read"] },
        },
        customerPermissions: ["catalog:read"],
      },
    });
    cleanup = harness.cleanup;
    const kernel = createKernel(harness.config);
    auth = createAuth(kernel.database, harness.config);
    db = kernel.database.db as DrizzleDatabase;
    probe = new Hono<{ Variables: { actor: Actor | null } }>();
    probe.use("*", authMiddleware(auth, harness.config));
    probe.get("/probe", (c) => c.json(c.get("actor")));
  });

  afterAll(async () => {
    await cleanup();
  });

  it("refuses a listed role whose user has not enabled 2FA, with a code that says why", async () => {
    const owner = await signedInMember("owner");
    const res = await probeAs(owner.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "TWO_FACTOR_REQUIRED" } });
  });

  it("refuses a composite role that contains a listed role", async () => {
    // Better Auth stores a member's role as a comma-separated list; "owner,admin" is an owner.
    const owner = await signedInMember("owner,admin");
    const res = await probeAs(owner.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "TWO_FACTOR_REQUIRED" } });
  });

  it("serves the same role once the user has enabled 2FA", async () => {
    const owner = await signedInMember("owner");
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, owner.userId));
    const res = await probeAs(owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: owner.userId, role: "owner" });
  });

  it("leaves roles that are not listed alone", async () => {
    const staff = await signedInMember("staff");
    const res = await probeAs(staff.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: staff.userId, role: "staff" });
  });

  it("refuses to boot with required roles while two-factor is disabled", async () => {
    const harness = await createPGliteTestConfig({
      auth: { twoFactor: { enabled: false, requiredForRoles: ["owner"] } },
    });
    try {
      const kernel = createKernel(harness.config);
      expect(() => createAuth(kernel.database, harness.config)).toThrow(/requiredForRoles/);
    } finally {
      await harness.cleanup();
    }
  });
});
