import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AuthInstance } from "../src/auth/setup.js";
import type { Actor } from "../src/auth/types.js";
import type { CommerceConfig } from "../src/config/types.js";
import { authMiddleware } from "../src/auth/middleware.js";
import { createAuth } from "../src/auth/setup.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const OVERRIDE_PERMISSIONS = [
  "s3-05-path-a",
  "s3-05-path-b",
] as const;

type ProbeEnv = { Variables: { actor: Actor | null } };

function createProbeApp(auth: AuthInstance, config: CommerceConfig) {
  const app = new Hono<ProbeEnv>();
  app.use("*", authMiddleware(auth, config));
  app.get("/probe", (c) =>
    c.json({ permissions: (c.get("actor") as Actor | null)?.permissions ?? null }),
  );
  return app;
}

function createNoRoleSessionAuth(): AuthInstance {
  return {
    api: {
      getSession: async () => ({
        user: {
          id: "dedupe-test-user",
          email: "dedupe@test.local",
          name: "Dedupe Test",
        },
        session: {
          activeOrganizationId: null,
          activeOrganizationRole: null,
        },
      }),
    },
  } as unknown as AuthInstance;
}

async function resolveStoreOrg(): Promise<string | null> {
  return "org_dedupe_storefront";
}

describe("customerPermissions single source (middleware)", () => {
  it("session path (no org role): uses config.auth.customerPermissions override", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      auth: {
        customerPermissions: [...OVERRIDE_PERMISSIONS],
      },
    });
    try {
      const app = createProbeApp(createNoRoleSessionAuth(), config);
      const res = await app.request("http://localhost/probe");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { permissions: string[] | null };
      expect(body.permissions).toEqual([...OVERRIDE_PERMISSIONS]);
    } finally {
      await cleanup();
    }
  });

  it("anonymous storeResolver path: uses same config.auth.customerPermissions override", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      auth: {
        customerPermissions: [...OVERRIDE_PERMISSIONS],
        storeResolver: resolveStoreOrg,
      },
    });
    try {
      const kernel = createKernel(config);
      const auth = createAuth(kernel.database, config);
      const app = createProbeApp(auth, config);
      const res = await app.request("http://localhost/probe");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { permissions: string[] | null };
      expect(body.permissions).toEqual([...OVERRIDE_PERMISSIONS]);
    } finally {
      await cleanup();
    }
  });
});
