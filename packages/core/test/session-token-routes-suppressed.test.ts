import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { session } from "../src/auth/auth-schema.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { SUPPRESSED_AUTH_PATHS } from "../src/auth/suppressed-auth-paths.js";

/**
 * Better Auth's `GET /list-sessions` hands an authenticated caller the raw
 * bearer `token` of EVERY one of their live sessions, and its `POST
 * /revoke-session` takes such a token as its only handle. Together they turn
 * one compromised session into durable capture of all of them, surviving the
 * victim revoking the single session they know about.
 *
 * The library does not strip it: `parseSessionOutput` filters by the session
 * output schema, and `token` carries no `returned: false` in
 * `@better-auth/core`'s `get-tables`, unlike `parseAccountOutput` which strips
 * its tokens by name one function above it.
 *
 * Both paths are now in Better Auth's own `disabledPaths`. This suite is what
 * stops them coming back, and its rows are chosen so each failure mode is
 * distinguishable from the others:
 *
 *   - A refusal row alone cannot tell suppression from a broken probe, so the
 *     controls — `/api/health` 200 and a never-defined auth path 404 — run
 *     against the same server.
 *   - A refusal row alone cannot see OVER-refusal, so the routes that must keep
 *     working (`get-session`, `revoke-other-sessions`, `sign-out`) are asserted
 *     to still work AND to still end a session.
 *   - A path list cannot say whether its entries name anything. The landing
 *     check asserts every suppressed path against the endpoint table the built
 *     auth instance actually exposes, so a library rename that moved
 *     `/list-sessions` reddens here instead of leaving a live route behind a
 *     guard that matches nothing.
 */

const PASSWORD = "Suppress-Passw0rd!";

type TestServer = Awaited<ReturnType<typeof createServer>>;

async function boot(): Promise<TestServer> {
  return createServer(
    await createTestConfig({
      // The auth limiter defaults to 10/minute and this suite makes more auth
      // calls than that. A 429 wears the colour of a refusal and would pass the
      // suppression rows for the wrong reason.
      rateLimits: { auth: 500, session: 500 },
    }),
  );
}

async function authRequest(
  server: TestServer,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const { cookie, headers, ...rest } = init;
  // `app.request` is typed `Response | Promise<Response>`; awaiting it here is
  // what narrows it, rather than a cast at every call site.
  return await server.app.request(`http://localhost/api/auth/${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
  });
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

function liveTokens(server: TestServer, userId: string): Promise<Array<{ token: string }>> {
  const db = server.kernel.database.db as DrizzleDatabase;
  return db
    .select({ token: session.token })
    .from(session)
    .where(eq(session.userId, userId));
}

/** Sign one user in twice, so two sessions are live and one of them is "the other". */
async function twoSessions(
  server: TestServer,
  email: string,
): Promise<{ userId: string; a: string; b: string }> {
  const first = await authRequest(server, "sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
  expect(first.status, "sign-up").toBe(200);
  const created = (await first.json()) as { user: { id: string } };

  const second = await authRequest(server, "sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(second.status, "sign-in").toBe(200);

  const a = cookieOf(first);
  const b = cookieOf(second);
  expect(a, "sign-up set a session cookie").not.toBe("");
  expect(b, "sign-in set a session cookie").not.toBe("");
  expect(a, "the two sign-ins mint distinct sessions").not.toBe(b);
  return { userId: created.user.id, a, b };
}

async function sessionOf(server: TestServer, cookie: string): Promise<unknown> {
  const response = await authRequest(server, "get-session", { cookie });
  if (response.status !== 200) return null;
  const body = (await response.json()) as { session?: unknown } | null;
  return body?.session ?? null;
}

describe("the session routes that put a bearer token on the wire are suppressed", () => {
  it("GET /api/auth/list-sessions is refused, and no session token reaches the wire", async () => {
    const server = await boot();
    const { userId, a } = await twoSessions(server, `list-${Date.now()}@test.local`);

    // Read the tokens the route used to hand out, so the leak assertion is
    // anchored to real values rather than to a shape that could be absent for
    // an unrelated reason.
    const rows = await liveTokens(server, userId);
    expect(rows.length, "two live sessions are available to leak").toBe(2);

    const response = await authRequest(server, "list-sessions", { cookie: a });
    const body = await response.text();
    const leaked = rows.filter((row) => body.includes(row.token)).length;

    // The leak is asserted BEFORE the status: a status-first order aborts the
    // row on the refusal and never prints how many tokens were on the wire,
    // which is the number this card exists about.
    expect(leaked, `session tokens present in the response body: ${leaked} of ${rows.length}`).toBe(0);
    expect(response.status, "list-sessions is refused").toBe(404);
  });

  it("POST /api/auth/revoke-session is refused, and the session it named survives", async () => {
    const server = await boot();
    const { userId, a, b } = await twoSessions(server, `revoke-${Date.now()}@test.local`);

    const rows = await liveTokens(server, userId);
    const victim = rows[0]?.token;
    expect(typeof victim, "a real token to aim the call at").toBe("string");

    const response = await authRequest(server, "revoke-session", {
      method: "POST",
      cookie: a,
      body: JSON.stringify({ token: victim }),
    });
    expect(response.status, "revoke-session is refused").toBe(404);

    // A 404 that deleted the row anyway would be the same status and the
    // opposite outcome, so the table is read back rather than inferred.
    expect((await liveTokens(server, userId)).length, "the refused revoke deleted nothing").toBe(2);
    expect(await sessionOf(server, a), "the calling session still authenticates").not.toBeNull();
    expect(await sessionOf(server, b), "the targeted session still authenticates").not.toBeNull();
  });

  it("the refusal is a measurement: /api/health answers 200 and an undefined auth path 404s alike", async () => {
    const server = await boot();

    const health = await server.app.request("http://localhost/api/health");
    expect(health.status, "positive control — the server is up and routing").toBe(200);

    const absent = await authRequest(server, "no-such-endpoint-ever");
    expect(absent.status, "negative control — an auth path Better Auth never defined").toBe(404);
  });

  it("does not over-refuse: get-session, revoke-other-sessions and sign-out still work and still bite", async () => {
    const server = await boot();
    const { a, b } = await twoSessions(server, `keep-${Date.now()}@test.local`);

    expect(await sessionOf(server, b), "get-session still serves the caller's own session").not.toBeNull();

    // "Log out everywhere else" takes no token, so it is the supported way to
    // end a session whose token the caller cannot — and must not — obtain.
    const others = await authRequest(server, "revoke-other-sessions", { method: "POST", cookie: b });
    expect(others.status, "revoke-other-sessions still works").toBe(200);
    expect(await sessionOf(server, a), "and it actually ended the other session").toBeNull();

    const signOut = await authRequest(server, "sign-out", { method: "POST", cookie: b });
    expect(signOut.status, "sign-out still works").toBe(200);
    expect(await sessionOf(server, b), "and it actually ended this one").toBeNull();
  });

  it("every suppressed path names a route Better Auth actually defines", async () => {
    const server = await boot();

    // Each entry of `auth.api` is a callable endpoint carrying its own `path`
    // property — a function, not a plain object, which is why this reads the
    // property rather than testing the value's type first.
    const endpoints = new Set(
      Object.values<unknown>(server.commerce.auth.api)
        .map((endpoint) => (endpoint as { path?: unknown } | null)?.path)
        .filter((path): path is string => typeof path === "string"),
    );

    expect(endpoints.size, "the endpoint table was readable at all").toBeGreaterThan(10);
    expect(SUPPRESSED_AUTH_PATHS.length, "something is suppressed").toBeGreaterThan(0);
    for (const suppressed of SUPPRESSED_AUTH_PATHS) {
      expect(
        endpoints.has(suppressed.path),
        `${suppressed.path} is not a path Better Auth defines — the guard would cover nothing`,
      ).toBe(true);
    }
  });
});
