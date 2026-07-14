import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AuthInstance } from "../src/auth/setup.js";
import type { Actor } from "../src/auth/types.js";
import type { CommerceConfig } from "../src/config/types.js";
import { authMiddleware } from "../src/auth/middleware.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

type ProbeEnv = { Variables: { actor: Actor | null } };

const injectedActor: Actor = {
  type: "user",
  userId: "sec19-injected",
  email: "injected@test.local",
  name: "Injected",
  vendorId: null,
  organizationId: "org_default",
  role: "owner",
  permissions: ["*:*"],
};

function createNoSessionAuth(): AuthInstance {
  return {
    api: {
      getSession: async () => null,
    },
  } as unknown as AuthInstance;
}

function createProbeApp(auth: AuthInstance, config: CommerceConfig) {
  const app = new Hono<ProbeEnv>();
  app.use("*", authMiddleware(auth, config));
  app.get("/probe", (c) => c.json({ actor: c.get("actor") }));
  return app;
}

describe("SEC-19 — x-test-actor requires explicit opt-in", () => {
  it("ignores x-test-actor when allowTestActor is false (default)", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      auth: { allowTestActor: false },
    });
    try {
      const app = createProbeApp(createNoSessionAuth(), config);
      const res = await app.request("http://localhost/probe", {
        headers: { "x-test-actor": JSON.stringify(injectedActor) },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { actor: Actor | null };
      expect(body.actor).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("honors x-test-actor when allowTestActor is true", async () => {
    const { config, cleanup } = await createPGliteTestConfig({
      auth: { allowTestActor: true },
    });
    try {
      const app = createProbeApp(createNoSessionAuth(), config);
      const res = await app.request("http://localhost/probe", {
        headers: { "x-test-actor": JSON.stringify(injectedActor) },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { actor: Actor };
      expect(body.actor.userId).toBe("sec19-injected");
      expect(body.actor.role).toBe("owner");
    } finally {
      await cleanup();
    }
  });
});