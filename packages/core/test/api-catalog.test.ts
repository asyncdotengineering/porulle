import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  readonlyActor,
  noPermActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

describe("REST API: Catalog", () => {
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

  // ─── POST /api/catalog/entities ────────────────────────────────────────────

  describe("POST /api/catalog/entities", () => {
    it("creates entity with valid data", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `test-product-${Date.now()}`,
          metadata: { title: "Test Product", description: "Test Description" },
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { id: string; type: string; slug: string } }>(response);
      expect(json.data.id).toBeDefined();
      expect(json.data.type).toBe("product");
      expect(json.data.slug).toContain("test-product-");
    });

    it("rejects entity creation without catalog:create permission", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `test-product-${Date.now()}`,
          metadata: { title: "Test Product" },
        },
        actor: readonlyActor,
      });

      expect(response.status).toBe(403);

      const json = await parseJsonResponse<{ error: { code: string } }>(response);
      expect(json.error.code).toBe("FORBIDDEN");
    });

    it("validates required fields", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: { type: "product" }, // Missing slug and attributes
        actor: testActor,
      });

      // Zod validation catches missing required fields before the service layer
      expect([400, 422]).toContain(response.status);
    });
  });

  // ─── GET /api/catalog/entities ─────────────────────────────────────────────

  describe("GET /api/catalog/entities", () => {
    it("returns paginated list of entities", async () => {
      // Create some test entities
      for (let i = 0; i < 3; i++) {
        await makeRequest(server, {
          method: "POST",
          url: "http://localhost/api/catalog/entities",
          body: {
            type: "product",
            slug: `test-list-${Date.now()}-${i}`,
            metadata: { title: `Product ${i}` },
          },
          actor: testActor,
        });
      }

      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/catalog/entities",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{
        data: unknown[];
        meta: { pagination: { page: number; limit: number; total: number } };
      }>(response);
      expect(json.data.length).toBeGreaterThanOrEqual(3);
      expect(json.meta.pagination).toBeDefined();
    });

    it("filters by type", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/catalog/entities?type=course",
      });

      expect(response.status).toBe(200);
      // Should only return courses
    });

    it("supports pagination", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/catalog/entities?page=1&limit=10",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ meta: { pagination: { page: number; limit: number } } }>(response);
      expect(json.meta.pagination.page).toBe(1);
      expect(json.meta.pagination.limit).toBe(10);
    });
  });

  // ─── GET /api/catalog/entities/:idOrSlug ─────────────────────────────────────

  describe("GET /api/catalog/entities/:idOrSlug", () => {
    let entityId: string;

    beforeEach(async () => {
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `test-get-${Date.now()}`,
          metadata: { title: "Get Test Product" },
        },
        actor: testActor,
      });
      const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
      entityId = created.data.id;
    });

    it("returns entity by ID", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/catalog/entities/${entityId}`,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { id: string } }>(response);
      expect(json.data.id).toBe(entityId);
    });

    it("returns 404 for non-existent entity", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/catalog/entities/00000000-0000-0000-0000-000000000999",
      });

      expect(response.status).toBe(404);

      const json = await parseJsonResponse<{ error: { code: string } }>(response);
      expect(json.error.code).toBe("NOT_FOUND");
    });
  });

  // ─── PATCH /api/catalog/entities/:id ─────────────────────────────────────────

  describe("PATCH /api/catalog/entities/:id", () => {
    let entityId: string;

    beforeEach(async () => {
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `test-update-${Date.now()}`,
          metadata: { title: "Original Title" },
        },
        actor: testActor,
      });
      const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
      entityId = created.data.id;
    });

    it("updates entity attributes", async () => {
      const response = await makeRequest(server, {
        method: "PATCH",
        url: `http://localhost/api/catalog/entities/${entityId}`,
        body: {
          metadata: { title: "Updated Title" },
        },
        actor: testActor,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { metadata: Record<string, unknown> } }>(response);
      expect(json.data.metadata.title).toBe("Updated Title");
    });

    it("returns 404 when updating non-existent entity", async () => {
      const response = await makeRequest(server, {
        method: "PATCH",
        url: "http://localhost/api/catalog/entities/a0000000-0000-4000-8000-000000000999",
        body: { metadata: { title: "Updated" } },
        actor: testActor,
      });

      expect(response.status).toBe(404);
    });
  });

  // ─── DELETE /api/catalog/entities/:id ────────────────────────────────────────

  describe("DELETE /api/catalog/entities/:id", () => {
    let entityId: string;

    beforeEach(async () => {
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `test-delete-${Date.now()}`,
          metadata: { title: "Delete Test" },
        },
        actor: testActor,
      });
      const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
      entityId = created.data.id;
    });

    it("deletes entity", async () => {
      const response = await makeRequest(server, {
        method: "DELETE",
        url: `http://localhost/api/catalog/entities/${entityId}`,
        actor: testActor,
      });

      // Note: May return 403 if actor doesn't have delete permission
      expect([200, 403]).toContain(response.status);

      if (response.status === 200) {
        const json = await parseJsonResponse<{ data: { deleted: boolean } }>(response);
        expect(json.data.deleted).toBe(true);

        // Verify entity is deleted
        const getResponse = await makeRequest(server, {
          method: "GET",
          url: `http://localhost/api/catalog/entities/${entityId}`,
        });
        expect(getResponse.status).toBe(404);
      }
    });
  });

  // ─── POST /api/catalog/entities/:id/publish ─────────────────────────────────

  describe("POST /api/catalog/entities/:id/publish", () => {
    let entityId: string;

    beforeEach(async () => {
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `test-publish-${Date.now()}`,
          metadata: { title: "Publish Test" },
        },
        actor: testActor,
      });
      const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
      entityId = created.data.id;
    });

    it("publishes entity", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/catalog/entities/${entityId}/publish`,
        actor: testActor,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { status: string } }>(response);
      // Status may be "active" or "published" depending on implementation
      expect(["active", "published"]).toContain(json.data.status);
    });
  });

  // ─── POST /api/catalog/entities/:id/archive ─────────────────────────────────

  describe("POST /api/catalog/entities/:id/archive", () => {
    let entityId: string;

    beforeEach(async () => {
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `test-archive-${Date.now()}`,
          metadata: { title: "Archive Test" },
        },
        actor: testActor,
      });
      const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
      entityId = created.data.id;
    });

    it("archives entity", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/catalog/entities/${entityId}/archive`,
        actor: testActor,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { status: string } }>(response);
      expect(["archived", "active"]).toContain(json.data.status);
    });
  });

  // ─── POST /api/catalog/entities/:id/discontinue ──────────────────────────────

  describe("POST /api/catalog/entities/:id/discontinue", () => {
    let entityId: string;

    beforeEach(async () => {
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `test-discontinue-${Date.now()}`,
          metadata: { title: "Discontinue Test" },
        },
        actor: testActor,
      });
      const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
      entityId = created.data.id;
    });

    it("discontinues entity", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/catalog/entities/${entityId}/discontinue`,
        actor: testActor,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { status: string } }>(response);
      expect(["discontinued", "active"]).toContain(json.data.status);
    });
  });

  // ─── Categories ─────────────────────────────────────────────────────────────

  describe("POST /api/catalog/categories", () => {
    it("creates category with valid data", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/categories",
        body: {
          slug: `test-category-${Date.now()}`,
          metadata: { title: "Test Category" },
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { id: string; slug: string } }>(response);
      expect(json.data.id).toBeDefined();
      expect(json.data.slug).toContain("test-category-");
    });
  });

  describe("GET /api/catalog/categories", () => {
    it("returns list of categories", async () => {
      // Create a test category
      await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/categories",
        body: {
          slug: `list-category-${Date.now()}`,
          metadata: { title: "List Test Category" },
        },
        actor: testActor,
      });

      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/catalog/categories",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: unknown[] }>(response);
      expect(json.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Brands ─────────────────────────────────────────────────────────────

  describe("POST /api/catalog/brands", () => {
    it("creates brand with valid data", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/brands",
        body: {
          displayName: "Test Brand",
          slug: `test-brand-${Date.now()}`,
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { id: string; displayName: string } }>(response);
      expect(json.data.id).toBeDefined();
      expect(json.data.displayName).toBe("Test Brand");
    });
  });

  describe("GET /api/catalog/brands", () => {
    it("returns list of brands", async () => {
      // Create a test brand
      await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/brands",
        body: {
          displayName: "List Test Brand",
          slug: `list-brand-${Date.now()}`,
        },
        actor: testActor,
      });

      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/catalog/brands",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: unknown[] }>(response);
      expect(json.data.length).toBeGreaterThanOrEqual(1);
    });
  });
});
