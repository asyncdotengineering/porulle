import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resolveActor } from "../src/index.js";
import { session } from "../src/auth/auth-schema.js";
import type { AuthInstance } from "../src/auth/setup.js";
import { createAuth } from "../src/auth/setup.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

function createAuthApp(auth: AuthInstance) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return app;
}

function allCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0] ?? "")
    .filter((pair) => pair.includes("="))
    .join("; ");
}

describe("sign-out invalidates on the next request", () => {
  it("resolves no actor for a revoked session, even when the client still holds the cached session cookie", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      auth: {
        defaultOrganizationId: "org_default",
        requireEmailVerification: false,
        trustedOrigins: ["http://localhost"],
      },
    });
    try {
      const kernel = createKernel(config);
      const auth = createAuth(kernel.database, config);
      const db = kernel.database.db as DrizzleDatabase;
      const authApp = createAuthApp(auth);

      const email = `revocation-${Date.now()}@test.local`;
      const signUp = await authApp.request(
        "http://localhost/api/auth/sign-up/email",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body: JSON.stringify({
            email,
            password: "TestPassword123!",
            name: "Revocation Test",
          }),
        },
      );
      expect(signUp.status).toBe(200);
      const { user } = (await signUp.json()) as { user: { id: string } };

      const signIn = await authApp.request(
        "http://localhost/api/auth/sign-in/email",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body: JSON.stringify({ email, password: "TestPassword123!" }),
        },
      );
      expect(signIn.status).toBe(200);
      const cookie = allCookies(signIn);
      const { token } = (await signIn.json()) as { token: string };

      // Session liveness has one source of truth. A signed cookie carrying a
      // copy of it is a second one, and it is what kept a revoked session
      // authorized for five minutes.
      expect(cookie).not.toContain("uc.session_data=");

      const beforeSignOut = await resolveActor(
        new Headers({ cookie }),
        auth,
        config,
      );
      expect(beforeSignOut?.userId).toBe(user.id);

      const signOut = await authApp.request(
        "http://localhost/api/auth/sign-out",
        {
          method: "POST",
          headers: { cookie, origin: "http://localhost" },
        },
      );
      expect(signOut.status).toBe(200);

      const rows = await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.token, token));
      expect(rows).toHaveLength(0);

      const afterSignOut = await resolveActor(
        new Headers({ cookie }),
        auth,
        config,
      );
      expect(afterSignOut).toBeNull();

      // The surface measured at 200 against the deployed commerce API on
      // 2026-09-12, with the same cookie, immediately after sign-out.
      const staleSession = await authApp.request(
        "http://localhost/api/auth/get-session",
        { headers: { cookie, origin: "http://localhost" } },
      );
      expect(await staleSession.json()).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
