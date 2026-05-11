import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineCommercePlugin } from "../src/kernel/plugin/manifest.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { testAdminActor, testStaffActor } from "../src/test-utils/test-actors.js";

describe("GET /api/admin/permissions", () => {
  const permPlugin = defineCommercePlugin({
    id: "gift-cards-introspect",
    version: "1.0.0",
    permissions: [
      {
        scope: "gift-cards:admin",
        description: "Configure and redeem gift cards",
      },
    ],
  });

  let cleanup: () => Promise<void>;
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];

  beforeAll(async () => {
    const bundle = await createTestServer({ plugins: [permPlugin] });
    server = bundle.server;
    cleanup = bundle.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("returns core + plugin permissions for admin actors", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/admin/permissions",
      actor: testAdminActor,
    });
    expect(res.status).toBe(200);
    const body = await parseJsonResponse<{
      core: string[];
      plugin: Array<{ scope: string; description: string; plugin: string }>;
    }>(res);
    expect(Array.isArray(body.core)).toBe(true);
    expect(body.core).toContain("*:*");
    expect(body.plugin).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "gift-cards:admin",
          description: "Configure and redeem gift cards",
          plugin: "gift-cards-introspect",
        }),
      ]),
    );
  });

  it("denies non-admin actors", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/admin/permissions",
      actor: testStaffActor,
    });
    expect(res.status).toBe(403);
  });
});
