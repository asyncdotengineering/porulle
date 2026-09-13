import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../src/index.js";
import { authMiddleware } from "../src/auth/middleware.js";
import { createAuth } from "../src/auth/setup.js";
import type { AuthInstance } from "../src/auth/setup.js";
import { createRestRoutes } from "../src/interfaces/rest/index.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import type { CommerceConfig } from "../src/config/types.js";

/**
 * Which refusal an unauthenticated caller is told.
 *
 * Since the store resolver began resolving an organization for anonymous
 * requests, a caller with no credential no longer arrives without an actor: the
 * middleware sets an anonymous customer actor, and the permission guard refuses
 * it with 403 and the name of the permission it lacks.
 *
 * Both halves of that are wrong, and each costs something real. RFC 9110
 * §15.5.4 reserves 403 for a request the server refuses whatever credentials
 * accompany it, and §15.5.2 gives 401 to a request that "lacks valid
 * authentication credentials", requiring a `WWW-Authenticate` challenge with it.
 * The mobile client's fetch interceptor keys on 401 to prompt a sign-in, so the
 * class is not cosmetic. And naming `cart:manage` to a caller with no identity
 * enumerates the permission model to someone who has not knocked.
 *
 * BOTH DIRECTIONS ARE ASSERTED HERE ON PURPOSE. A blanket status swap would
 * satisfy the first test and fail the second; a change that only softened the
 * message would satisfy neither. Neither test may be weakened into the other.
 */

const ANONYMOUS_ORG = "org_default";

async function createApp(overrides: Partial<CommerceConfig> = {}): Promise<{
  app: Hono;
  auth: AuthInstance;
  cleanup: () => Promise<void>;
}> {
  const { config, cleanup } = await createPGliteTestConfig({
    auth: {
      defaultOrganizationId: ANONYMOUS_ORG,
      requireEmailVerification: false,
      trustedOrigins: ["http://localhost"],
      // The anonymous branch of authMiddleware only fires when a store resolver
      // is configured — which is the deployment shape this card is about.
      storeResolver: () => ANONYMOUS_ORG,
      customerPermissions: ["catalog:read"],
    },
    ...overrides,
  });
  const kernel = createKernel(config);
  const auth = createAuth(kernel.database, config);

  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.use("*", authMiddleware(auth, config));
  app.route("/api", createRestRoutes(kernel));

  return { app, auth, cleanup };
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const firstCookie = setCookie?.split(", ")[0] ?? "";
  const separator = firstCookie.indexOf("=");
  const token = firstCookie.slice(separator + 1).split(";")[0];
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function signUpShopper(app: Hono): Promise<string> {
  const signUp = await app.request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      email: `refusal-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      password: "TestPassword123!",
      name: "Shopper",
    }),
  });
  expect(signUp.status).toBe(200);
  return sessionCookie(signUp);
}

describe("the refusal an unauthenticated caller is told", () => {
  it("answers 401 with an authentication challenge and no permission name", async () => {
    const { app, cleanup } = await createApp();
    try {
      const response = await app.request("http://localhost/api/carts");
      const body = (await response.json()) as { error?: { code?: string; message?: string } };

      expect(
        response.status,
        `a caller with no credential must be told to authenticate, not that it is personally forbidden — got ${response.status} ${JSON.stringify(body)}`,
      ).toBe(401);
      expect(body.error?.code).toBe("UNAUTHORIZED");

      // NOT asserted here, deliberately: RFC 9110 §15.5.2 also requires a 401 to
      // carry a `WWW-Authenticate` challenge, and none of core's 401s does —
      // including the ones that predate this change. Adding one means shaping a
      // response header from five return sites inside the auth middleware, which
      // is a larger and more dangerous diff than the status class this card is
      // about. It is a separate card, not an omission.

      // The absence is the point, not only the status: a 401 that still names
      // the permission has fixed the class and kept the disclosure.
      expect(
        body.error?.message ?? "",
        `the refusal must not name a permission to a caller with no identity — got ${body.error?.message}`,
      ).not.toMatch(/cart:manage/);
    } finally {
      await cleanup();
    }
  });

  it("still answers 403 naming the permission to a signed-in caller who lacks it", async () => {
    const { app, cleanup } = await createApp();
    try {
      const cookie = await signUpShopper(app);
      const response = await app.request("http://localhost/api/carts", {
        headers: { cookie },
      });
      const body = (await response.json()) as { error?: { code?: string; message?: string } };

      // THE GUARD AGAINST A BLANKET SWAP. This caller has an identity and
      // authenticating again would not help, which is exactly what 403 means.
      expect(
        response.status,
        `a signed-in shopper without cart:manage must still be refused 403 — got ${response.status} ${JSON.stringify(body)}`,
      ).toBe(403);
      expect(body.error?.code).toBe("FORBIDDEN");
      expect(
        body.error?.message ?? "",
        "an operator debugging a role must still be told which permission is missing",
      ).toMatch(/cart:manage/);
    } finally {
      await cleanup();
    }
  });

  it("answers 401 rather than 'you do not have access' on an ownership refusal", async () => {
    // The second half of the same defect, and a different code path: the cart
    // read is not permission-guarded, so it is `assertCartReadAccess` that
    // refuses — with "You do not have access to this resource." at 403. Fixing
    // only the permission guard would leave this row saying the old thing.
    const { app, cleanup } = await createApp({
      auth: {
        defaultOrganizationId: ANONYMOUS_ORG,
        requireEmailVerification: false,
        trustedOrigins: ["http://localhost"],
        storeResolver: () => ANONYMOUS_ORG,
        customerPermissions: ["catalog:read", "cart:create"],
      },
    });
    try {
      // A cart belonging to a CUSTOMER, which is the row the deployed gate
      // asserts. A guest cart takes the secret-gated branch instead and is a
      // different question; a nonexistent id is 404 before any access check and
      // would make this pass for the wrong reason.
      const owner = await signUpShopper(app);
      const created = await app.request("http://localhost/api/carts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner },
        body: JSON.stringify({ currency: "LKR" }),
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const { data } = (await created.json()) as { data: { id: string; customerId: string | null } };
      expect(data.customerId, "this row is about a cart with an owner").not.toBeNull();

      // No credential at all.
      const response = await app.request(`http://localhost/api/carts/${data.id}`);
      const body = (await response.json()) as { error?: { code?: string; message?: string } };

      expect(
        response.status,
        `an anonymous read of someone's cart must be told to authenticate — got ${response.status} ${JSON.stringify(body)}`,
      ).toBe(401);
      expect(body.error?.code).toBe("UNAUTHORIZED");
    } finally {
      await cleanup();
    }
  });
});
