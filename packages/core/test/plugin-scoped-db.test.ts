import { describe, it, expect, beforeAll, vi } from "vitest";
import { defineCommercePlugin } from "../src/kernel/plugin/manifest.js";
import { createPluginTestApp } from "../src/test-utils/create-plugin-test-app.js";
import { jsonHeaders } from "../src/test-utils/test-actors.js";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import { sellableEntities } from "../src/modules/catalog/schema.js";
import type { PluginTestApp } from "../src/test-utils/create-plugin-test-app.js";

const ORG_A = "org_plugin_scoped_a";
const ORG_B = "org_plugin_scoped_b";

const actorA: Actor = {
  type: "user",
  userId: "user-a",
  email: "a@test.local",
  name: "A",
  vendorId: null,
  organizationId: ORG_A,
  role: "admin",
  permissions: ["*:*"],
};

const actorB: Actor = {
  ...actorA,
  userId: "user-b",
  email: "b@test.local",
  name: "B",
  organizationId: ORG_B,
};

function scopedDbTestPlugin() {
  return defineCommercePlugin({
    id: "scoped-db-plugin-test",
    version: "0.0.1",
    routes: (ctx) => [
      {
        method: "post",
        path: "/api/plugin/scoped-db/insert",
        handler: async () => {
          const slug = `entity-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const [row] = await ctx.database.db
            .insert(sellableEntities)
            .values({
              type: "product",
              slug,
              status: "draft",
              isVisible: false,
              metadata: {},
              organizationId: ORG_A,
            })
            .returning();
          return Response.json(row);
        },
      },
      {
        method: "get",
        path: "/api/plugin/scoped-db/scoped-list",
        handler: async () => {
          const rows = await ctx.database.db.select().from(sellableEntities);
          return Response.json({
            slugs: rows.map((r) => r.slug),
            orgs: [...new Set(rows.map((r) => r.organizationId))],
          });
        },
      },
      {
        method: "get",
        path: "/api/plugin/scoped-db/unscoped-list",
        handler: async () => {
          const rows = await ctx.database.unscoped.select().from(sellableEntities);
          return Response.json({ count: rows.length });
        },
      },
    ],
  });
}

describe("PluginContext scoped database", () => {
  let env: PluginTestApp;

  beforeAll(async () => {
    env = await createPluginTestApp(scopedDbTestPlugin());
    await env.db.insert(organization).values({
      id: ORG_A,
      name: "Org A",
      slug: "org-a-scoped-test",
      createdAt: new Date(),
    });
    await env.db.insert(organization).values({
      id: ORG_B,
      name: "Org B",
      slug: "org-b-scoped-test",
      createdAt: new Date(),
    });
  }, 60_000);

  it("scoped db stamps insert and scoped select only returns actor org rows", async () => {
    const insA = await env.app.request("/api/plugin/scoped-db/insert", {
      method: "POST",
      headers: jsonHeaders(actorA),
    });
    expect(insA.status).toBe(200);
    const bodyA = (await insA.json()) as { organizationId: string; slug: string };
    expect(bodyA.organizationId).toBe(ORG_A);

    const insB = await env.app.request("/api/plugin/scoped-db/insert", {
      method: "POST",
      headers: jsonHeaders(actorB),
    });
    expect(insB.status).toBe(200);
    const bodyB = (await insB.json()) as { organizationId: string; slug: string };
    expect(bodyB.organizationId).toBe(ORG_B);

    const listA = await env.app.request("/api/plugin/scoped-db/scoped-list", {
      headers: jsonHeaders(actorA),
    });
    expect(listA.status).toBe(200);
    const scopedA = (await listA.json()) as { slugs: string[]; orgs: string[] };
    expect(scopedA.orgs).toEqual([ORG_A]);
    expect(scopedA.slugs.length).toBeGreaterThanOrEqual(1);
    expect(scopedA.slugs).toContain(bodyA.slug);

    const listB = await env.app.request("/api/plugin/scoped-db/scoped-list", {
      headers: jsonHeaders(actorB),
    });
    const scopedB = (await listB.json()) as { slugs: string[]; orgs: string[] };
    expect(scopedB.orgs).toEqual([ORG_B]);
    expect(scopedB.slugs).toContain(bodyB.slug);
  });

  it("unscoped db returns cross-org rows and emits deprecation warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await env.app.request("/api/plugin/scoped-db/unscoped-list", {
      headers: jsonHeaders(actorA),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { count: number };
    expect(data.count).toBeGreaterThanOrEqual(2);

    expect(
      warnSpy.mock.calls.some((call) => String(call[0] ?? "").includes("[plugin:database]")),
    ).toBe(true);

    warnSpy.mockRestore();
  });
});
