import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  CommerceReauthRequiredError,
  resolveActor,
  SESSION_COOKIE_NAME,
} from "../src/index.js";
import { session } from "../src/auth/auth-schema.js";
import type { AuthInstance } from "../src/auth/setup.js";
import { createAuth } from "../src/auth/setup.js";
import { mapErrorToResponse, mapErrorToStatus } from "../src/kernel/error-mapper.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

function createAuthApp(auth: AuthInstance) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return app;
}

function sessionCookie(response: Response): string {
  const firstCookie = response.headers.get("set-cookie")?.split(", ")[0] ?? "";
  const separator = firstCookie.indexOf("=");
  return `${SESSION_COOKIE_NAME}=${firstCookie.slice(separator + 1).split(";")[0]}`;
}

describe("step-up re-authentication", () => {
  it("maps REAUTH_REQUIRED to 401 and keeps the reason readable in production", () => {
    const error = new CommerceReauthRequiredError("Re-authentication required.");

    expect(error.code).toBe("REAUTH_REQUIRED");
    expect(mapErrorToStatus(error)).toBe(401);

    // A step-up refusal is only useful if the client can tell it from a signed-out
    // 401, so the code and the reason must both survive the production scrubber.
    const { body, status } = mapErrorToResponse(error, true);
    expect(status).toBe(401);
    expect(body.error.code).toBe("REAUTH_REQUIRED");
    expect(body.error.message).toBe("Re-authentication required.");
  });

  it("carries the session's authentication time on the actor", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      auth: {
        defaultOrganizationId: "org_default",
        requireEmailVerification: false,
        trustedOrigins: ["http://localhost"],
        customerPermissions: ["catalog:read"],
      },
    });
    try {
      const kernel = createKernel(config);
      const auth = createAuth(kernel.database, config);
      const db = kernel.database.db as DrizzleDatabase;
      const authApp = createAuthApp(auth);

      const email = `step-up-${Date.now()}@test.local`;
      const signUp = await authApp.request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ email, password: "TestPassword123!", name: "Step Up" }),
      });
      expect(signUp.status).toBe(200);

      const signIn = await authApp.request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ email, password: "TestPassword123!" }),
      });
      expect(signIn.status).toBe(200);
      const cookie = sessionCookie(signIn);
      const { token } = (await signIn.json()) as { token: string };

      const actor = await resolveActor(new Headers({ cookie }), auth, config);
      const [row] = await db
        .select({ createdAt: session.createdAt })
        .from(session)
        .where(eq(session.token, token));
      expect(actor?.sessionCreatedAt).toBe(row?.createdAt.toISOString());

      // The clock moves by rewriting the row, never by waiting: a session signed in
      // an hour ago must read as an hour old on the very next actor resolution.
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await db
        .update(session)
        .set({ createdAt: anHourAgo })
        .where(eq(session.token, token));
      const staleActor = await resolveActor(new Headers({ cookie }), auth, config);
      expect(staleActor?.sessionCreatedAt).toBe(anHourAgo.toISOString());

      // An actor with no session at all — a job, an API key — states that it has no
      // authentication time rather than leaving the field undefined, so a guard that
      // reads it can refuse the unknown case instead of falling through it.
      const { createSystemActor } = await import("../src/auth/system-actor.js");
      expect(createSystemActor("org_default").sessionCreatedAt).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
