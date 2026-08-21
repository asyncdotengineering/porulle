import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { assertRouteCoverage, findUncoveredRoutes } from "../src/interfaces/rest/route-coverage.js";
import { createTestServer } from "../src/test-utils/rest-api-test-utils.js";
import { requireMethodPerm } from "../src/interfaces/rest/utils.js";

describe("REST route permission coverage", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testServer = await createTestServer();
    server = testServer.server;
    cleanup = testServer.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("classifies every route registered by the built app", () => {
    expect(findUncoveredRoutes(server)).toEqual([]);
    assertRouteCoverage(server);
  });

  it("fails when a throwaway unguarded route is registered", async () => {
    const testServer = await createTestServer();
    try {
      testServer.server.get("/api/_4f9ee97f_unguarded", (c) => c.text("unguarded"));
      expect(() => assertRouteCoverage(testServer.server)).toThrow(
        "GET /api/_4f9ee97f_unguarded",
      );
    } finally {
      await testServer.cleanup();
    }
  });

  it("does not let a GET-only guard cover a POST endpoint", () => {
    const app = new Hono();
    app.use("/api/_method-sensitive", requireMethodPerm(["GET"], "catalog:read"));
    app.post("/api/_method-sensitive", (c) => c.text("unguarded"));

    expect(findUncoveredRoutes(app)).toContain("POST /api/_method-sensitive");
  });
});
