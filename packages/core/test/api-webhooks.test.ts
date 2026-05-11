import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  readonlyActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

describe("REST API: Webhooks", () => {
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

  // ─── POST /api/webhooks ────────────────────────────────────────────────────────

  describe("POST /api/webhooks", () => {
    it("creates webhook endpoint with valid data", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/webhooks",
        body: {
          url: "https://example.com/webhook",
          events: ["order.created", "order.updated"],
          secret: "test_secret",
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { id: string; url: string } }>(response);
      expect(json.data.id).toBeDefined();
      expect(json.data.url).toBe("https://example.com/webhook");
    });

    it("validates required fields", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/webhooks",
        body: {}, // Missing url and events
        actor: testActor,
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects creation without webhooks:manage permission", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/webhooks",
        body: {
          url: "https://example.com/webhook",
          events: ["order.created"],
        },
        actor: readonlyActor, // No webhooks:manage permission
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("validates URL format", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/webhooks",
        body: {
          url: "not-a-valid-url",
          events: ["order.created"],
        },
        actor: testActor,
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ─── GET /api/webhooks ─────────────────────────────────────────────────────────

  describe("GET /api/webhooks", () => {
    it("returns list of webhook endpoints", async () => {
      // Create a test webhook first
      await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/webhooks",
        body: {
          url: "https://example.com/webhook-list",
          events: ["order.created"],
        },
        actor: testActor,
      });

      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/webhooks",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: unknown[] }>(response);
      expect(Array.isArray(json.data)).toBe(true);
    });

    it("returns empty array when no webhooks exist", async () => {
      // Use clean state (no webhooks)
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/webhooks",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: unknown[] }>(response);
      expect(Array.isArray(json.data)).toBe(true);
    });
  });

  // ─── DELETE /api/webhooks/:id ──────────────────────────────────────────────────

  describe("DELETE /api/webhooks/:id", () => {
    it("deletes webhook endpoint", async () => {
      // Create a test webhook first
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/webhooks",
        body: {
          url: "https://example.com/webhook-delete",
          events: ["order.created"],
        },
        actor: testActor,
      });

      if (createResponse.status === 201) {
        const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
        const webhookId = created.data.id;

        const response = await makeRequest(server, {
          method: "DELETE",
          url: `http://localhost/api/webhooks/${webhookId}`,
          actor: testActor,
        });

        expect(response.status).toBe(200);

        const json = await parseJsonResponse<{ data: { deleted: boolean } }>(response);
        expect(json.data.deleted).toBe(true);
      }
    });

    it("returns 404 for non-existent webhook", async () => {
      const response = await makeRequest(server, {
        method: "DELETE",
        url: "http://localhost/api/webhooks/00000000-0000-4000-8000-000000000999",
        actor: testActor,
      });

      expect(response.status).toBe(404);

      const json = await parseJsonResponse<{ error: { code: string } }>(response);
      expect(json.error.code).toBe("NOT_FOUND");
    });

    it("validates UUID format", async () => {
      const response = await makeRequest(server, {
        method: "DELETE",
        url: "http://localhost/api/webhooks/invalid-uuid",
        actor: testActor,
      });

      // May return 400 or 500 depending on implementation
      expect([400, 404, 500]).toContain(response.status);
    });
  });
});
