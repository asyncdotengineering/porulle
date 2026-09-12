import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { resolveActor, SESSION_COOKIE_NAME } from "../src/index.js";
import type { AuthInstance } from "../src/auth/setup.js";
import { createAuth } from "../src/auth/setup.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

/**
 * What one authenticated request costs, counted rather than timed.
 *
 * The queries behind `resolveActor` take 0.3 ms of database time between them.
 * They are not slow; there are simply several of them and they are strictly
 * serial, so a request pays the round trip once per query. On a Worker sitting a
 * continent away from its database that was the difference between a 213 ms and
 * a 906 ms `GET /health`.
 *
 * That makes a stopwatch the wrong guard: it measures the network, it is flaky
 * in CI, and when it regresses it does not say what regressed. A COUNT is
 * stable, runs in-process against PGlite, and names the mechanism.
 *
 * These assertions are deliberately about the mechanism and not only the total.
 * A future change that keeps the total at four by swapping one wasteful read for
 * another should fail here, which a bare `toBeLessThan` would not catch.
 */

function createAuthApp(auth: AuthInstance) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return app;
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const firstCookie = setCookie?.split(", ")[0] ?? "";
  const separator = firstCookie.indexOf("=");
  const token = firstCookie.slice(separator + 1).split(";")[0];
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** Statements naming a table, so a count can be read per table rather than as a lump. */
function countTouching(queries: string[], table: string): number {
  const pattern = new RegExp(`(from|into|update|join)\\s+"?${table}"?\\b`, "i");
  return queries.filter((q) => pattern.test(q)).length;
}

function writesTo(queries: string[], table: string): number {
  const pattern = new RegExp(`^\\s*(update|insert\\s+into)\\s+"?${table}"?\\b`, "i");
  return queries.filter((q) => pattern.test(q)).length;
}

/**
 * The statements this card is answerable for.
 *
 * `jwks` belongs to the JWT plugin's key handling, not to actor resolution —
 * counting it would make this gate fail on the first run of a fresh database
 * (which generates a key) and pass on the second, which is a flaky gate rather
 * than a strict one. Excluded by name so the exclusion is visible instead of
 * hidden inside a loose upper bound.
 */
function actorCost(queries: string[]): string[] {
  return queries.filter((q) => !/\bjwks\b/i.test(q));
}

describe("resolveActor query cost", () => {
  it("resolves a shopper with no organization membership without loading an organization", async () => {
    const { config, cleanup, queryLog } = await createPGliteTestConfig({
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
      const authApp = createAuthApp(auth);

      const signUp = await authApp.request(
        "http://localhost/api/auth/sign-up/email",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body: JSON.stringify({
            email: `shopper-cost-${Date.now()}@test.local`,
            password: "TestPassword123!",
            name: "Shopper",
          }),
        },
      );
      expect(signUp.status).toBe(200);
      const headers = new Headers({ cookie: sessionCookie(signUp) });

      queryLog.start();
      const actor = await resolveActor(headers, auth, config);
      const queries = queryLog.stop();

      // The actor itself is unchanged by this card — assert it, so a "fix" that
      // wins the count by resolving less is caught here rather than in production.
      expect(actor?.role).toBe("customer");
      expect(actor?.organizationId).toBe("org_default");
      expect(actor?.permissions).toEqual(["catalog:read"]);
      expect(actor?.sessionCreatedAt).toEqual(expect.any(String));

      // THE MECHANISM. A shopper is not a member of the platform organization and
      // never will be, so every one of these is a guaranteed miss paid forever.
      expect(
        countTouching(queries, "organization"),
        `a shopper's request must not load an organization — issued:\n${queries.join("\n")}`,
      ).toBe(0);
      expect(
        countTouching(queries, "invitation"),
        `a shopper's request must not read invitations — issued:\n${queries.join("\n")}`,
      ).toBe(0);

      // A read must not write. `update session` on the hot path of every GET
      // turns a cache-able read into a round trip that cannot be skipped.
      expect(
        writesTo(queries, "session"),
        `resolving an actor must not write the session row — issued:\n${queries.join("\n")}`,
      ).toBe(0);

      // The session must be resolved ONCE. Two session reads and two user reads
      // is the signature of getSession running twice — which is what the
      // organization-plugin endpoints do when they re-resolve from headers.
      expect(
        countTouching(queries, "session"),
        `the session must be read once, not once per plugin endpoint — issued:\n${queries.join("\n")}`,
      ).toBe(1);
      expect(
        countTouching(queries, "user"),
        `the user must be read once — issued:\n${queries.join("\n")}`,
      ).toBe(1);

      // The total, last, so a failure above names the cause before the symptom.
      //
      // THREE, not two, and the difference is worth stating because the card
      // that ordered this work said two in its prose and three in its
      // pseudocode. Three is right: a member's session does not carry
      // `activeOrganizationRole` either, so there is no way to know a caller is
      // a shopper without asking once. The miss IS the answer. Driving this to
      // two would mean stamping the role into the session at creation — a
      // different change, and one that puts a write back on a path this card
      // exists to take writes off.
      const cost = actorCost(queries);
      expect(
        cost.length,
        `a shopper should cost 3 statements (session, user, one membership miss) — issued ${cost.length}:\n${cost.join("\n")}`,
      ).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("resolves an organization member by one indexed membership read", async () => {
    const { config, cleanup, queryLog } = await createPGliteTestConfig({
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
      const authApp = createAuthApp(auth);
      const db = kernel.database.db as never;

      const signUp = await authApp.request(
        "http://localhost/api/auth/sign-up/email",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body: JSON.stringify({
            email: `member-cost-${Date.now()}@test.local`,
            password: "TestPassword123!",
            name: "Member",
          }),
        },
      );
      expect(signUp.status).toBe(200);
      const headers = new Headers({ cookie: sessionCookie(signUp) });

      const before = await resolveActor(headers, auth, config);
      const userId = before?.userId;
      expect(userId).toEqual(expect.any(String));

      const { member } = await import("../src/auth/auth-schema.js");
      await (db as { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } })
        .insert(member)
        .values({
          id: `mem_${Date.now()}`,
          organizationId: "org_default",
          userId,
          role: "staff",
          createdAt: new Date(),
        });

      queryLog.start();
      const actor = await resolveActor(headers, auth, config);
      const queries = queryLog.stop();

      expect(actor?.role).toBe("staff");
      expect(actor?.organizationId).toBe("org_default");
      expect(actor?.permissions).toEqual(["catalog:read", "orders:read"]);

      // The membership is found by the indexed (user_id, organization_id) read,
      // not by loading the organization and scanning its member list in JS.
      expect(
        countTouching(queries, "organization"),
        `membership must be read directly, not by loading the organization — issued:\n${queries.join("\n")}`,
      ).toBe(0);
      expect(
        countTouching(queries, "invitation"),
        `membership resolution must not read invitations — issued:\n${queries.join("\n")}`,
      ).toBe(0);
      expect(
        countTouching(queries, "member"),
        `exactly one membership read — issued:\n${queries.join("\n")}`,
      ).toBe(1);
      expect(
        writesTo(queries, "session"),
        `resolving an actor must not write the session row — issued:\n${queries.join("\n")}`,
      ).toBe(0);

      // Three: session, user, and the one indexed membership read.
      const cost = actorCost(queries);
      expect(
        cost.length,
        `a member should cost 3 statements (session, user, member) — issued ${cost.length}:\n${cost.join("\n")}`,
      ).toBe(3);
    } finally {
      await cleanup();
    }
  });
});
