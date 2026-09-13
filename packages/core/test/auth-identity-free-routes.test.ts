import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../src/index.js";
import { authMiddleware } from "../src/auth/middleware.js";
import { createAuth } from "../src/auth/setup.js";
import { createRestRoutes } from "../src/interfaces/rest/index.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import type { QueryLog } from "../src/test-utils/create-pglite-adapter.js";

/**
 * Which routes have an actor, counted rather than timed.
 *
 * `authMiddleware` is mounted `app.use("*", …)` and resolves an actor before
 * every handler, so a route that reads no actor still pays the three statements
 * that produce one whenever a credential happens to be present. On the deployed
 * Worker that is the difference between a 140 ms and a 210 ms `GET /health`.
 *
 * The danger in fixing it is not the cost, it is the direction of failure: a
 * route that silently stops receiving an actor does not break loudly, it 401s,
 * or takes an anonymous branch and answers. So both directions are pinned here,
 * and the second one is the important one.
 *
 * DEFAULT IS TO RESOLVE. A route that declares nothing keeps its actor. The
 * declaration is an explicit, exact-match allowlist of routes proven to read no
 * actor — not a pattern, because a pattern is how one entry silently widens to
 * cover a route that does need an identity.
 */

const ORG = "org_default";

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const firstCookie = setCookie?.split(", ")[0] ?? "";
  const separator = firstCookie.indexOf("=");
  const token = firstCookie.slice(separator + 1).split(";")[0];
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** Statements naming a table, so a count reads per table rather than as a lump. */
function countTouching(queries: string[], table: string): number {
  const pattern = new RegExp(`(from|into|update|join)\\s+"?${table}"?\\b`, "i");
  return queries.filter((q) => pattern.test(q)).length;
}

async function createApp(identityFreeRoutes?: readonly string[]): Promise<{
  app: Hono;
  queryLog: QueryLog;
  cookie: string;
  cleanup: () => Promise<void>;
}> {
  const { config, cleanup, queryLog } = await createPGliteTestConfig({
    auth: {
      defaultOrganizationId: ORG,
      requireEmailVerification: false,
      trustedOrigins: ["http://localhost"],
      storeResolver: () => ORG,
      customerPermissions: ["catalog:read"],
      ...(identityFreeRoutes ? { identityFreeRoutes } : {}),
    },
  });
  const kernel = createKernel(config);
  const auth = createAuth(kernel.database, config);

  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.use("*", authMiddleware(auth, config));
  // An APP-LOCAL route core knows nothing about — the shape the config seam
  // exists for (a signed payment notify, a tracked click-out). It reads no
  // actor, exactly like the handlers behind core's own three defaults.
  app.get("/api/app-local-notify", (c) => c.json({ ok: true }));
  app.route("/api", createRestRoutes(kernel));

  const signUp = await app.request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      email: `identity-free-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      password: "TestPassword123!",
      name: "Shopper",
    }),
  });
  expect(signUp.status).toBe(200);

  return { app, queryLog, cookie: sessionCookie(signUp), cleanup };
}

describe("routes that declare no identity requirement", () => {
  it("resolves no actor for GET /api/health even when a valid credential is presented", async () => {
    const { app, queryLog, cookie, cleanup } = await createApp();
    try {
      queryLog.start();
      const response = await app.request("http://localhost/api/health", {
        headers: { cookie },
      });
      const queries = queryLog.stop();

      expect(response.status, await response.clone().text()).toBe(200);

      // THE MECHANISM, per table, so a failure names what came back rather than
      // only that the total moved. These three are exactly what `resolveActor`
      // issues, and `/health` reads none of what they produce.
      expect(
        countTouching(queries, "session"),
        `an identity-free route must not read the session — issued:\n${queries.join("\n")}`,
      ).toBe(0);
      expect(
        countTouching(queries, "user"),
        `an identity-free route must not read the user — issued:\n${queries.join("\n")}`,
      ).toBe(0);
      expect(
        countTouching(queries, "member"),
        `an identity-free route must not read membership — issued:\n${queries.join("\n")}`,
      ).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("costs a credentialled GET /api/health exactly what an anonymous one costs", async () => {
    const { app, queryLog, cookie, cleanup } = await createApp();
    try {
      queryLog.start();
      await app.request("http://localhost/api/health");
      const anonymous = queryLog.stop();

      queryLog.start();
      await app.request("http://localhost/api/health", { headers: { cookie } });
      const credentialled = queryLog.stop();

      // `/health` issues its own `SELECT 1` probe, so the honest assertion is
      // that the credential adds NOTHING — not that the route issues zero.
      expect(
        credentialled.length,
        `presenting a credential must not add a statement — anonymous issued ${anonymous.length}:\n${anonymous.join("\n")}\ncredentialled issued ${credentialled.length}:\n${credentialled.join("\n")}`,
      ).toBe(anonymous.length);
    } finally {
      await cleanup();
    }
  });

  it("honours a route an app declares in config, not only core's own three", async () => {
    // The list is configuration because the routes that need it are app-local:
    // a signed payment notify, a tracked click-out. If it were a core constant
    // the first of those would mean another framework release.
    const { app, queryLog, cookie, cleanup } = await createApp([
      "GET /api/app-local-notify",
    ]);
    try {
      queryLog.start();
      const response = await app.request("http://localhost/api/app-local-notify", {
        headers: { cookie },
      });
      const queries = queryLog.stop();

      expect(response.status, await response.clone().text()).toBe(200);
      expect(
        countTouching(queries, "session"),
        `a config-declared route must not read the session — issued:\n${queries.join("\n")}`,
      ).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("leaves an app-local route alone when the app does not declare it", async () => {
    // The other half of the seam, and the half that makes the row above mean
    // something: the same route, with no config entry, still resolves its actor.
    const { app, queryLog, cookie, cleanup } = await createApp();
    try {
      queryLog.start();
      const response = await app.request("http://localhost/api/app-local-notify", {
        headers: { cookie },
      });
      const queries = queryLog.stop();

      expect(response.status, await response.clone().text()).toBe(200);
      expect(
        countTouching(queries, "session"),
        `an undeclared route must still resolve its actor — issued:\n${queries.join("\n")}`,
      ).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("still resolves an actor for a route that declares nothing", async () => {
    // THE FAIL-OPEN GUARD. Sabotage the allowlist so it covers /api/carts and
    // this test must go red: a route that never declared itself losing its
    // actor is the one outcome this change may not produce.
    const { app, queryLog, cookie, cleanup } = await createApp();
    try {
      queryLog.start();
      const response = await app.request("http://localhost/api/carts", {
        headers: { cookie },
      });
      const queries = queryLog.stop();
      const body = (await response.json()) as { error?: { code?: string; message?: string } };

      expect(
        countTouching(queries, "session"),
        `a route that declares nothing must still resolve its actor — issued:\n${queries.join("\n")}`,
      ).toBe(1);

      // Proven by what the refusal SAYS, not only by the statement count: a
      // signed-in shopper lacking `cart:manage` is told 403 and which
      // permission. If the actor had gone missing this would be a 401 instead,
      // and the route would have quietly stopped knowing who was calling.
      expect(
        response.status,
        `the actor must still reach the guard — got ${response.status} ${JSON.stringify(body)}`,
      ).toBe(403);
      expect(body.error?.message ?? "").toMatch(/cart:manage/);
    } finally {
      await cleanup();
    }
  });
});
