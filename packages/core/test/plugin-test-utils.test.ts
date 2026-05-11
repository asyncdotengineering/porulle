import { describe, expect, it } from "vitest";
import { createTestPluginContext } from "../src/test-utils/create-test-plugin-context.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

describe("plugin test utilities", () => {
  it("captures plugin registrations with createTestPluginContext", async () => {
    const ctx = await createTestPluginContext();

    ctx.routes.add("get", "/api/plugin/test", () => new Response("ok"));
    ctx.analytics.registerModel({ name: "PluginModel" });
    ctx.database.registerSchema({ plugin_table: { id: "uuid" } });

    expect(ctx.registeredRoutes[0]?.path).toBe("/api/plugin/test");
    expect((ctx.registeredAnalyticsModels[0] as any)?.name).toBe("PluginModel");
    expect(ctx.registeredSchemas[0]).toEqual({ plugin_table: { id: "uuid" } });
  });

  it("boots a minimal kernel with createTestKernel", async () => {
    const kernel = await createTestKernel();
    const health = await kernel.services.catalog.list({ pagination: { page: 1, limit: 5 } });
    expect(health.ok).toBe(true);
  });
});
