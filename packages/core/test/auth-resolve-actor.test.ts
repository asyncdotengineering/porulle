import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE_PREFIX,
  resolveActor,
  SESSION_COOKIE_NAME,
  type Actor,
} from "../src/index.js";
import { authMiddleware } from "../src/auth/middleware.js";
import { member, session } from "../src/auth/auth-schema.js";
import type { AuthInstance } from "../src/auth/setup.js";
import { createAuth } from "../src/auth/setup.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

type ProbeEnv = { Variables: { actor: Actor | null } };

function createAuthApp(auth: AuthInstance) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return app;
}

function createProbeApp(
  auth: AuthInstance,
  config: Awaited<ReturnType<typeof createPGliteTestConfig>>["config"],
) {
  const app = new Hono<ProbeEnv>();
  app.use("*", authMiddleware(auth, config));
  app.get("/probe", (c) => c.json(c.get("actor")));
  return app;
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const firstCookie = setCookie?.split(", ")[0] ?? "";
  const separator = firstCookie.indexOf("=");
  const cookieName = firstCookie.slice(0, separator);
  const token = firstCookie.slice(separator + 1).split(";")[0];
  expect(cookieName).toBe(SESSION_COOKIE_NAME);
  expect(token).toEqual(expect.any(String));
  return `${SESSION_COOKIE_NAME}=${token}`;
}

describe("resolveActor", () => {
  it("matches middleware for cookie and bearer sessions, and rejects invalid sessions", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      auth: {
        defaultOrganizationId: "org_default",
        requireEmailVerification: false,
        trustedOrigins: ["http://localhost"],
        roles: { staff: { permissions: ["catalog:read", "orders:read"] } },
        customerPermissions: ["catalog:read"],
      },
    });
    try {
      const kernel = createKernel(config);
      const auth = createAuth(kernel.database, config);
      const db = kernel.database.db as DrizzleDatabase;
      const authApp = createAuthApp(auth);

      const email = `resolve-actor-${Date.now()}@test.local`;
      const signUpResponse = await authApp.request(
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
            name: "Resolver Test",
          }),
        },
      );
      expect(signUpResponse.status).toBe(200);
      const signUpBody = (await signUpResponse.json()) as {
        user: { id: string };
      };

      await db.insert(member).values({
        id: `member-${signUpBody.user.id}`,
        organizationId: "org_default",
        userId: signUpBody.user.id,
        role: "staff",
        createdAt: new Date(),
      });

      const signInResponse = await authApp.request(
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
      expect(signInResponse.status).toBe(200);
      const cookie = sessionCookie(signInResponse);
      const signInBody = (await signInResponse.json()) as { token: string };

      expect(AUTH_COOKIE_PREFIX).toBe("uc");

      const cookieActor = await resolveActor(
        new Headers({ cookie }),
        auth,
        config,
      );
      expect(cookieActor).toMatchObject({
        userId: signUpBody.user.id,
        organizationId: "org_default",
        role: "staff",
      });

      const bearerActor = await resolveActor(
        new Headers({ authorization: `Bearer ${signInBody.token}` }),
        auth,
        config,
      );
      expect(bearerActor).toEqual(cookieActor);

      const probeResponse = await createProbeApp(auth, config).request(
        "http://localhost/probe",
        {
          headers: { cookie },
        },
      );
      expect(probeResponse.status).toBe(200);
      const middlewareActor = (await probeResponse.json()) as Actor;
      expect(middlewareActor).toEqual(cookieActor);
      expect(cookieActor).toEqual({
        type: "user",
        userId: signUpBody.user.id,
        email,
        name: "Resolver Test",
        vendorId: null,
        organizationId: "org_default",
        role: "staff",
        permissions: ["catalog:read", "orders:read"],
      });

      await expect(
        resolveActor(new Headers(), auth, config),
      ).resolves.toBeNull();
      await expect(
        resolveActor(
          new Headers({ cookie: `${SESSION_COOKIE_NAME}=malformed` }),
          auth,
          config,
        ),
      ).resolves.toBeNull();

      await db
        .update(session)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(session.token, signInBody.token));
      await expect(
        resolveActor(new Headers({ cookie }), auth, config),
      ).resolves.toBeNull();
    } finally {
      await cleanup();
    }
  });
});
