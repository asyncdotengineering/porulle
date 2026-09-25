/**
 * A credential that was PRESENTED and failed verification is refused with 401. It is not served as
 * an anonymous guest.
 *
 * Measured on a deployed Worker (2026-09-25): `POST /api/carts` with
 * `Authorization: Bearer <junk>` answered 201 and created a guest cart. The middleware treated an
 * invalid, expired or rate-limited key as a rejection, and fell through to anonymous. So:
 *  - a shopper whose token expired silently got a fresh guest cart and lost theirs;
 *  - a broken client never learned its auth failed;
 *  - an operator key typo became an anonymous request.
 *
 * Absent credentials stay anonymous: guest checkout depends on it. A stale session COOKIE is out of
 * scope. Browsers carry stale cookies on every public page, and refusing them would 401 logged-out
 * browsing. Only a credential the caller deliberately sends (`authorization`, `x-api-key`) counts
 * as presented.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import { createTestServer } from "../src/test-utils/rest-api-test-utils.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { authMiddleware } from "../src/auth/middleware.js";
import type { AuthInstance } from "../src/auth/setup.js";
import type { CommerceConfig } from "../src/config/types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

describe("a presented credential that fails verification", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let db: DrizzleDatabase;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    // The deployed app resolves an anonymous caller to its store (`storeResolver`), which is what
    // makes a guest cart possible; the harness's own auth defaults are kept and only that is added.
    const defaults = await createPGliteTestConfig();
    const baseAuth = defaults.config.auth;
    await defaults.cleanup();
    const built = await createTestServer({ auth: { ...baseAuth, storeResolver: async () => "org_default" } });
    server = built.server;
    db = built.kernel.database.db as DrizzleDatabase;
    cleanup = built.cleanup;
  }, 60_000);
  afterAll(async () => { await cleanup(); });

  const cartCount = async (): Promise<number> => {
    const rows = await db.execute(sql`select count(*)::int as n from carts`);
    const first = (rows as unknown as { rows?: Array<{ n: number }> }).rows?.[0] ?? (rows as unknown as Array<{ n: number }>)[0];
    return first?.n ?? -1;
  };
  const createCart = (headers: Record<string, string>) => server.request("http://localhost/api/carts", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ currency: "LKR" }),
  });

  it("R1: no credential at all is a guest, and gets a cart", async () => {
    const before = await cartCount();
    const response = await createCart({});
    expect(response.status).toBe(201);
    expect(await cartCount()).toBe(before + 1);
  });

  it("R2: an unverifiable bearer is refused with 401 and a challenge, and writes no cart", async () => {
    const before = await cartCount();
    const response = await createCart({ authorization: "Bearer probe-junk-not-a-real-credential" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="api"');
    expect(await cartCount()).toBe(before);
  });

  it("R3: an unverifiable x-api-key is refused with 401, and writes no cart", async () => {
    const before = await cartCount();
    const response = await createCart({ "x-api-key": "probe-junk-not-a-real-credential" });
    expect(response.status).toBe(401);
    expect(await cartCount()).toBe(before);
  });

  it("R6: an EMPTY authorization header is no credential: still a guest", async () => {
    const response = await createCart({ authorization: "" });
    expect(response.status).toBe(201);
  });

  it("R7 (non-goal pinned): a stale session COOKIE alone is still a guest", async () => {
    const response = await createCart({ cookie: "better-auth.session_token=stale-not-a-session" });
    expect(response.status).toBe(201);
  });
});

describe("the rejection's kind decides the status", () => {
  const config = { version: "0.0.1", storeName: "T", database: { provider: "postgresql" }, auth: { defaultOrganizationId: "org_default", apiKeys: { enabled: true } } } as unknown as CommerceConfig;
  const app = (verifyApiKey: () => Promise<unknown>): Hono => {
    const hono = new Hono();
    hono.use("*", authMiddleware({ api: { getSession: async () => null, verifyApiKey } } as unknown as AuthInstance, config));
    hono.get("/probe", (c) => c.json({ ok: true }));
    return hono;
  };

  it("R5: a rate-limited key answers 429, not 401 and never anonymous", async () => {
    const response = await app(async () => { throw new APIError("TOO_MANY_REQUESTS", { message: "Rate limit exceeded." }); })
      .request("http://localhost/probe", { headers: { "x-api-key": "k_live_rate_limited" } });
    expect(response.status).toBe(429);
  });

  it("R5b: an invalid key (valid:false) answers 401", async () => {
    const response = await app(async () => ({ valid: false, key: null }))
      .request("http://localhost/probe", { headers: { "x-api-key": "k_live_invalid" } });
    expect(response.status).toBe(401);
  });

  it("R5c: no credential reaches the route as anonymous", async () => {
    const response = await app(async () => ({ valid: false, key: null })).request("http://localhost/probe");
    expect(response.status).toBe(200);
  });
});
