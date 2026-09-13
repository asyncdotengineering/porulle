import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware } from "../src/auth/middleware.js";
import { createAuth } from "../src/auth/setup.js";
import { createCustomerPortalRoutes } from "../src/interfaces/rest/customer-portal.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import type { Actor } from "../src/auth/types.js";

/**
 * Which refusal each class of caller gets from `/api/me`, made a contract.
 *
 * The portal's guard used to be `if (!actor?.userId)` → 401, which collapsed two
 * different callers into one answer: a visitor with no credential, and an API
 * key that authenticated perfectly well but is not a person. Telling a key to
 * authenticate is advice it cannot act on — it already did.
 *
 * The guard now separates them, and this file is what stops that separation
 * being an accident of ordering that a later edit undoes without noticing.
 *
 * It is ALSO the invariant the handlers depend on. Every route below the guard
 * casts to `AuthenticatedActor = Actor & { userId: string }` and calls
 * `customers.getByUserId(actor.userId, …)`. A guard that lets a null `userId`
 * through does not fail there — it calls `getByUserId(null)` with the cast
 * quietly lying. So the second case here is not only about a status class; it
 * is what keeps that cast true.
 */

const ORG = "org_default";

/**
 * The portal is mounted under `/api/me` by `createServer`; the shared REST test
 * server does not mount it at all, so it is wired here directly. `allowTestActor`
 * is how a specific actor SHAPE is put on a request — the point of these rows is
 * the shape, and signing a real API key in would not produce one with a null
 * userId on demand.
 */
async function createPortalApp(): Promise<{ app: Hono; cleanup: () => Promise<void> }> {
  const { config, cleanup } = await createPGliteTestConfig({
    auth: {
      defaultOrganizationId: ORG,
      requireEmailVerification: false,
      trustedOrigins: ["http://localhost"],
      allowTestActor: true,
    },
  });
  const kernel = createKernel(config);
  const auth = createAuth(kernel.database, config);
  const app = new Hono();
  app.use("*", authMiddleware(auth, config));
  app.route("/api/me", createCustomerPortalRoutes(kernel));
  return { app, cleanup };
}

const KEY_WITH_NO_PERSON: Actor = {
  type: "api_key",
  userId: null,
  email: null,
  name: "Integration key",
  vendorId: null,
  organizationId: "org_default",
  role: "api_key",
  // Deliberately generous: this key is not refused for lacking permission. It
  // is refused for not being a person, and a narrower key would let the wrong
  // reason pass for the right one.
  permissions: ["*:*"],
};

describe("/api/me refuses each class of caller in its own terms", () => {
  it("tells a caller with no credential to authenticate", async () => {
    const { app, cleanup } = await createPortalApp();
    try {
      const response = await app.request("http://localhost/api/me/profile");
      const body = (await response.json()) as { error?: { code?: string } };
      expect(response.status, JSON.stringify(body)).toBe(401);
      expect(body.error?.code).toBe("UNAUTHORIZED");
    } finally {
      await cleanup();
    }
  });

  it("tells an API key with no person that the portal needs a user, and does not tell it to authenticate", async () => {
    const { app, cleanup } = await createPortalApp();
    try {
      const response = await app.request("http://localhost/api/me/profile", {
        headers: { "x-test-actor": JSON.stringify(KEY_WITH_NO_PERSON) },
      });
      const body = (await response.json()) as { error?: { code?: string; message?: string } };

      // NOT 401. This caller presented a credential and it was accepted; being
      // told to authenticate would send it round a loop it cannot exit.
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(body.error?.code).toBe("FORBIDDEN");

      // The reason has to be in the body, or the two refusals differ only by a
      // number and an operator cannot tell which rule they hit.
      expect(
        body.error?.message ?? "",
        "the refusal must say that the portal needs a signed-in user",
      ).toMatch(/signed-in user/i);

      // And it must NOT be a 404 from `getByUserId(null)` further down, which is
      // what a guard that let this caller past would produce.
      expect(response.status).not.toBe(404);
    } finally {
      await cleanup();
    }
  });
});
