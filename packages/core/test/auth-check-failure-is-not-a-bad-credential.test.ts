/**
 * An auth check that FAILS is not a credential that was REJECTED.
 *
 * `authMiddleware` wrapped both `getSession` and `verifyApiKey` in a bare
 * `catch {}` and fell through to anonymous. Every exception — a broken module
 * graph, a database outage, a schema drift, a bug in the auth plugin — was
 * reported to the caller as 401 "Authentication required." and logged nowhere.
 *
 * That is a lie with a cost: the caller is told to check a credential that is
 * fine. A real instance took a downstream adopter roughly an hour to trace to
 * `TypeError: handler is not a function`, thrown inside better-call because two
 * better-auth copies were hoisted into one flat node_modules.
 *
 * It has also happened before. `auth-api-key-named-scope.test.ts` documents the
 * same silent 401 from a different throw, fixed in 0.12.0 by special-casing the
 * one known message. The swallow itself was left in place, so it recurred.
 *
 * Contract: an exception better-auth raises to REJECT a credential (`APIError`)
 * falls through to anonymous, as before. Anything else propagates, so the
 * request fails loudly as a fault instead of masquerading as a bad credential.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../src/auth/middleware.js";
import { APIError } from "better-auth/api";
import type { AuthInstance } from "../src/auth/setup.js";
import type { CommerceConfig } from "../src/config/types.js";

const config: CommerceConfig = {
  version: "0.0.1",
  storeName: "Test",
  database: { provider: "postgresql" },
  auth: {
    defaultOrganizationId: "org_default",
    apiKeys: { enabled: true },
    apiKeyScopes: {
      admin: { prefix: "k_adm_", permissions: { catalog: ["read"] } },
    },
  },
} as unknown as CommerceConfig;

function buildApp(auth: AuthInstance): Hono {
  const app = new Hono();
  app.use("*", authMiddleware(auth, config));
  app.get("/whoami", (c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actor = (c as any).get("actor");
    if (!actor) return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    return c.json({ type: actor.type });
  });
  app.onError((_err, c) =>
    c.json({ error: { code: "INTERNAL_ERROR" } }, 500),
  );
  return app;
}

function fakeAuth(overrides: Record<string, unknown>): AuthInstance {
  return {
    api: {
      getSession: async () => null,
      verifyApiKey: async () => ({ valid: false, key: null }),
      ...overrides,
    },
  } as unknown as AuthInstance;
}

const credentialRejection = () =>
  new APIError("UNAUTHORIZED", { message: "Invalid API key." });

describe("an auth check that fails is not a bad credential", () => {
  it("propagates a verifyApiKey fault instead of reporting 401", async () => {
    const app = buildApp(
      fakeAuth({
        verifyApiKey: async () => {
          throw new TypeError("handler is not a function");
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: { "x-api-key": "k_adm_live" },
    });

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
  });

  it("still falls through to anonymous when the key is genuinely rejected", async () => {
    const app = buildApp(
      fakeAuth({
        verifyApiKey: async () => {
          throw credentialRejection();
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: { "x-api-key": "k_adm_live" },
    });

    expect(res.status).toBe(401);
  });

  it("propagates a getSession fault instead of downgrading to anonymous", async () => {
    const app = buildApp(
      fakeAuth({
        getSession: async () => {
          throw new TypeError("handler is not a function");
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: { cookie: "uc.session_token=whatever" },
    });

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
  });

  it("still treats a rejected session as anonymous", async () => {
    const app = buildApp(
      fakeAuth({
        getSession: async () => {
          throw credentialRejection();
        },
      }),
    );

    const res = await app.request("/whoami", {
      headers: { cookie: "uc.session_token=whatever" },
    });

    expect(res.status).toBe(401);
  });
});
