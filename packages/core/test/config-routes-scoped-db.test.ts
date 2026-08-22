import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { Actor } from "../src/auth/types.js";
import type { CommerceConfig } from "../src/config/types.js";
import { createServer } from "../src/runtime/server.js";
import { requirePerm } from "../src/interfaces/rest/utils.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { organization } from "../src/auth/auth-schema.js";
import { sellableEntities } from "../src/modules/catalog/schema.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { jsonHeaders } from "../src/test-utils/test-actors.js";

const ORG_A = "org_config_route_a";
const ORG_B = "org_config_route_b";

const actorA: Actor = {
  type: "user",
  userId: "config-route-user-a",
  email: "config-route-a@test.local",
  name: "Config Route A",
  vendorId: null,
  organizationId: ORG_A,
  role: "admin",
  permissions: ["*:*"],
};

describe("config.routes database handles", () => {
  let app: Awaited<ReturnType<typeof createServer>>["app"];
  let kernel: Awaited<ReturnType<typeof createServer>>["kernel"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testConfig = await createPGliteTestConfig();
    cleanup = testConfig.cleanup;
    const auth = { ...testConfig.config.auth };
    delete auth.defaultOrganizationId;

    const config: CommerceConfig = {
      ...testConfig.config,
      auth: {
        ...auth,
        strictOrgResolution: true,
        storeResolver: () => null,
      },
      routes: (routeApp: Hono<any>, routeKernel) => {
        routeApp.get("/api/config-routes/rows/:handle", requirePerm("custom:read"), async (c) => {
          const db: DrizzleDatabase =
            c.req.param("handle") === "scoped"
              ? (routeKernel.database.scoped as unknown as DrizzleDatabase)
              : (routeKernel.database.db as DrizzleDatabase);
          const rows = await db.select().from(sellableEntities);
          return c.json({ orgs: [...new Set(rows.map((row) => row.organizationId))].sort() });
        });
      },
    };

    const server = await createServer(config);
    app = server.app;
    kernel = server.kernel;

    const db = kernel.database.db as DrizzleDatabase;
    await db.insert(organization).values([
      {
        id: ORG_A,
        name: "Config Route A",
        slug: "config-route-a",
        createdAt: new Date(),
      },
      {
        id: ORG_B,
        name: "Config Route B",
        slug: "config-route-b",
        createdAt: new Date(),
      },
    ]);
    await db.insert(sellableEntities).values([
      {
        organizationId: ORG_A,
        type: "product",
        slug: "config-route-product-a",
        status: "draft",
        isVisible: false,
        metadata: {},
      },
      {
        organizationId: ORG_B,
        type: "product",
        slug: "config-route-product-b",
        status: "draft",
        isVisible: false,
        metadata: {},
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("scopes the new handle while preserving the raw handle", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const scopedResponse = await app.request("/api/config-routes/rows/scoped", {
        headers: jsonHeaders(actorA),
      });
      expect(scopedResponse.status).toBe(200);
      expect(await scopedResponse.json()).toEqual({ orgs: [ORG_A] });

      await app.request("/api/config-routes/rows/raw", { headers: jsonHeaders(actorA) });
      const rawResponse = await app.request("/api/config-routes/rows/raw", {
        headers: jsonHeaders(actorA),
      });
      expect(rawResponse.status).toBe(200);
      expect(await rawResponse.json()).toEqual({ orgs: [ORG_A, ORG_B] });

      const warnings = warnSpy.mock.calls.filter((call) =>
        String(call[0] ?? "").includes("[config:database]"),
      );
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain("kernel.database.scoped");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not throw on an actor-less request when strict resolution has no answer", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
