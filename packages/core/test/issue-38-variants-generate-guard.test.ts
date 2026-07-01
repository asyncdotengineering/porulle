import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #38 — POST /entities/{id}/variants/generate crashed with a 500
// ("Cannot read properties of undefined (reading 'include')") for a missing /
// malformed strategy body instead of a 4xx validation error.
describe("Issue #38 — variants/generate strategy guard", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  let entityId: string;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const create = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `variants-${Date.now()}`, metadata: { title: "V" } },
      actor: testActor,
    });
    entityId = (await parseJsonResponse<{ data: { id: string } }>(create)).data.id;
  });

  it("rejects an empty-object strategy with a 4xx, not a 500", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/variants/generate`,
      body: {},
      actor: testActor,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const json = await parseJsonResponse<{ error: { code: string } }>(res);
    expect(json.error.code).not.toBe("INTERNAL_ERROR");
  });

  it("returns VALIDATION_FAILED (not a crash) when the service is called with no strategy", async () => {
    const result = await kernel.services.catalog.generateVariants(
      entityId,
      undefined,
      testActor,
    );
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("still generates variants for a valid { mode: 'all' } strategy", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/variants/generate`,
      body: { mode: "all" },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    const json = await parseJsonResponse<{ data: unknown[] }>(res);
    expect(Array.isArray(json.data)).toBe(true);
  });
});
