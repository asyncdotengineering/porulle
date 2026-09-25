/**
 * What `GET /api/auth/get-session` answers once a presented-but-invalid credential is refused
 * elsewhere.
 *
 * A downstream service (minimaldraft apps/api) resolves every caller through this route. It treats
 * `200` with no user as anonymous, and ANY other status as "identity provider unavailable", which
 * means a 503 on every authenticated and optional-auth route. The auth middleware now answers 401
 * for a presented credential that fails verification. The `/api/auth/*` handler is mounted before
 * that middleware, so get-session must keep answering 200 with a null session for a junk, revoked
 * or expired bearer. These rows measure it on the full server rather than argue it from the mount
 * order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

const ORIGIN = "http://localhost";

describe("get-session under a presented credential (full server)", () => {
  let app: Awaited<ReturnType<typeof createServer>>["app"];

  beforeAll(async () => {
    // The config is frozen, so the auth block is rebuilt around the harness's own defaults, on the
    // same database adapter.
    const base = await createTestConfig();
    const config = await createTestConfig({
      databaseAdapter: base.databaseAdapter,
      auth: { ...base.auth, trustedOrigins: [ORIGIN], storeResolver: async () => base.auth?.defaultOrganizationId ?? "org_default" },
    });
    app = (await createServer(config)).app;
  }, 60_000);

  const getSession = (headers: Record<string, string>) =>
    app.request("http://localhost/api/auth/get-session?disableCookieCache=true", { headers });
  const signUp = async (): Promise<string> => {
    const response = await app.request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: `shopper-${crypto.randomUUID()}@test.local`, password: "correct-horse-battery-staple", name: "Shopper" }),
    });
    expect(response.status).toBe(200);
    const token = response.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    return token ?? "";
  };
  const sessionUser = async (response: Response): Promise<unknown> => {
    const body = await response.json().catch(() => "unparseable");
    return body === null ? null : (body as { user?: unknown } | "unparseable") === "unparseable" ? "unparseable" : (body as { user?: unknown }).user ?? null;
  };

  it("G1: a junk bearer, no cookie → 200 with a null session (NOT 401)", async () => {
    const response = await getSession({ authorization: "Bearer probe-junk-not-a-real-credential" });
    expect(response.status).toBe(200);
    expect(await sessionUser(response)).toBeNull();
  });

  it("G2: a live bearer → 200 with the user", async () => {
    const token = await signUp();
    const response = await getSession({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(await sessionUser(response)).not.toBeNull();
  });

  it("G3: a REVOKED bearer (signed out with it) → 200 with a null session", async () => {
    const token = await signUp();
    const out = await app.request("http://localhost/api/auth/sign-out", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(out.status).toBe(200);
    const response = await getSession({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(await sessionUser(response)).toBeNull();
  });

  it("G4: a live bearer PLUS a stale session cookie → 200 with the user", async () => {
    const token = await signUp();
    const response = await getSession({ authorization: `Bearer ${token}`, cookie: "better-auth.session_token=stale-not-a-session" });
    expect(response.status).toBe(200);
    expect(await sessionUser(response)).not.toBeNull();
  });

  it("G5: a guest cart with no credential → 201", async () => {
    const response = await app.request("http://localhost/api/carts", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ currency: "LKR" }),
    });
    expect(response.status).toBe(201);
  });

  it("G6 (the intended change): a cart with a REVOKED bearer → 401, not a guest cart", async () => {
    const token = await signUp();
    await app.request("http://localhost/api/auth/sign-out", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    const response = await app.request("http://localhost/api/carts", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ currency: "LKR" }),
    });
    expect(response.status).toBe(401);
  });
});
