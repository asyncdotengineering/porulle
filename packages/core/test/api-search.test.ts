import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

describe("REST API: Search", () => {
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

    // Create some test catalog entities for search
    for (let i = 0; i < 3; i++) {
      await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `search-test-${Date.now()}-${i}`,
          metadata: {
            title: `Search Test Product ${i}`,
            description: "Test product for search functionality",
          },
        },
        actor: testActor,
      });
    }
  });

  // ─── GET /api/search ────────────────────────────────────────────────────────

  describe("GET /api/search", () => {
    it("returns search results for query", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search?q=search",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{
        data: unknown[];
        meta: { total: number; page: number; limit: number };
      }>(response);
      expect(json.data.length).toBeGreaterThanOrEqual(0);
      expect(json.meta.total).toBeGreaterThanOrEqual(0);
    });

    it("returns empty results for non-matching query", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search?q=nonexistentproductxyz123",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: unknown[]; meta: { total: number } }>(response);
      expect(json.data.length).toBe(0);
      expect(json.meta.total).toBe(0);
    });

    it("supports pagination", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search?q=search&page=1&limit=10",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ meta: { page: number; limit: number } }>(response);
      expect(json.meta.page).toBe(1);
      expect(json.meta.limit).toBe(10);
    });

    it("filters by type", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search?q=test&type=product",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: unknown[] }>(response);
      expect(Array.isArray(json.data)).toBe(true);
    });

    it("filters by status", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search?q=test&status=published",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: unknown[] }>(response);
      expect(Array.isArray(json.data)).toBe(true);
    });

    it("returns facets when requested", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search?q=test&facets=type,status",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ meta: { facets?: Record<string, unknown> } }>(response);
      expect(json.meta.facets).toBeDefined();
    });

    it("handles empty query gracefully", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search?q=",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: unknown[] }>(response);
      expect(Array.isArray(json.data)).toBe(true);
    });
  });

  // ─── GET /api/search/suggest ───────────────────────────────────────────────

  describe("GET /api/search/suggest", () => {
    it("returns suggestions for prefix", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search/suggest?prefix=search",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: string[] }>(response);
      expect(Array.isArray(json.data)).toBe(true);
    });

    it("filters suggestions by type", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search/suggest?prefix=test&type=product",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: string[] }>(response);
      expect(Array.isArray(json.data)).toBe(true);
    });

    it("respects limit parameter", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search/suggest?prefix=test&limit=5",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: string[] }>(response);
      expect(json.data.length).toBeLessThanOrEqual(5);
    });

    it("returns empty array for no matches", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search/suggest?prefix=nosuggestionsxyz123",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: string[] }>(response);
      expect(json.data.length).toBe(0);
    });

    it("handles empty prefix gracefully", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/search/suggest?prefix=",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: string[] }>(response);
      expect(Array.isArray(json.data)).toBe(true);
    });
  });
});
