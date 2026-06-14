/**
 * API-key auth under named scopes (#1)
 *
 * When `auth.apiKeyScopes` defines named scopes and none is called `default`,
 * a key minted under a named scope must still authenticate. Previously the
 * middleware called verifyApiKey without a configId, Better Auth threw
 * "No default api-key configuration found", the middleware swallowed it, and
 * the request was silently rejected as unauthenticated (401).
 *
 * Contract: a key minted under a named scope resolves to an `api_key` actor.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../src/auth/middleware.js";
import { createAuth } from "../src/auth/setup.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { ensureDefaultOrg } from "../src/auth/org.js";
import type { CommerceConfig } from "../src/config/types.js";

const authConfig: CommerceConfig["auth"] = {
  defaultOrganizationId: "org_default",
  requireEmailVerification: false,
  apiKeys: { enabled: true, defaultPermissions: ["catalog:read"] },
  apiKeyScopes: {
    // No scope named "default" — this is the reproducing condition.
    pos: { prefix: "app_pos_", description: "POS keys", permissions: { catalog: ["read"] } },
    admin: {
      prefix: "app_admin_",
      description: "Admin keys",
      permissions: { catalog: ["read", "create"] },
    },
  },
  roles: { owner: { permissions: ["*:*"] } },
};

describe("api-key auth under named scopes (#1)", () => {
  let app: Hono;
  let auth: ReturnType<typeof createAuth>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createPGliteTestConfig({ auth: authConfig });
    cleanup = built.cleanup;
    const kernel = createKernel(built.config);
    await ensureDefaultOrg(kernel.database.db);
    auth = createAuth(kernel.database, built.config);

    app = new Hono();
    app.use("*", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set("auth", auth);
      await next();
    });
    app.use("*", authMiddleware(auth, built.config));
    app.get("/whoami", (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actor = (c as any).get("actor");
      if (!actor) return c.json({ authed: false }, 401);
      return c.json({ authed: true, type: actor.type });
    });
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("authenticates a key minted under the named 'pos' scope", async () => {
    // Server-side mint under a named (non-default) scope.
    const created = (await auth.api.createApiKey({
      body: {
        configId: "pos",
        userId: "user_pos_1",
        permissions: { catalog: ["read"] },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const key = created.key as string;
    expect(key).toMatch(/^app_pos_/);

    const res = await app.request("/whoami", { headers: { "x-api-key": key } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authed: boolean; type?: string };
    expect(body.authed).toBe(true);
    expect(body.type).toBe("api_key");
  });
});
