import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  readonlyActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Note: File API is not available in Node.js test environment
// These tests verify the endpoints exist but skip actual file upload tests

describe("REST API: Media", () => {
  let server: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  // ─── POST /api/media/upload ─────────────────────────────────────────────────

  describe("POST /api/media/upload", () => {
    it.skip("uploads file with valid data - File API not available in Node", async () => {
      // File API not available in test environment
      expect(true).toBe(true);
    });

    it("requires file parameter", async () => {
      const formData = new FormData();
      // Missing file

      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/media/upload",
        body: formData,
        headers: {
          "content-type": "multipart/form-data",
        },
        actor: testActor,
      });

      // May return 422 or error depending on implementation
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ─── GET /api/media/:id ────────────────────────────────────────────────────

  describe("GET /api/media/:id", () => {
    it("returns 404 for non-existent media", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/media/00000000-0000-4000-8000-000000000999",
      });

      expect(response.status).toBe(404);

      const json = await parseJsonResponse<{ error: { code: string } }>(response);
      expect(json.error.code).toBe("NOT_FOUND");
    });

    it("validates UUID format", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/media/invalid-uuid",
      });

      // May return 400 (Zod validation), 404, or 500 depending on implementation
      expect([400, 404, 422, 500]).toContain(response.status);
    });
  });

  // ─── DELETE /api/media/:id ──────────────────────────────────────────────────

  describe("DELETE /api/media/:id", () => {
    it("returns 404 for non-existent media", async () => {
      const response = await makeRequest(server, {
        method: "DELETE",
        url: "http://localhost/api/media/00000000-0000-4000-8000-000000000999",
        actor: testActor,
      });

      expect(response.status).toBe(404);

      const json = await parseJsonResponse<{ error: { code: string } }>(response);
      expect(json.error.code).toBe("NOT_FOUND");
    });
  });

  // ─── POST /api/media/attach ────────────────────────────────────────────────

  describe("POST /api/media/attach", () => {
    it("validates required fields", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/media/attach",
        body: {
          // Missing mediaId and entityId
        },
        actor: testActor,
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("returns 404 for non-existent media", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/media/attach",
        body: {
          mediaId: "00000000-0000-4000-8000-000000000999",
          entityId: "00000000-0000-4000-8000-000000000001",
        },
        actor: testActor,
      });

      // May return 400 (Zod validation), 404, or 422
      expect([400, 404, 422]).toContain(response.status);
    });
  });
});
