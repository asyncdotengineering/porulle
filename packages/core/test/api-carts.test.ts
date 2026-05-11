import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  readonlyActor,
  noPermActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

describe("REST API: Carts", () => {
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

  // ─── POST /api/carts ─────────────────────────────────────────────────────

  describe("POST /api/carts", () => {
    it("creates cart with valid data", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: { currency: "USD" },
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { id: string; status: string; currency: string } }>(
        response,
      );
      expect(json.data.id).toBeDefined();
      expect(json.data.status).toBe("active");
      expect(json.data.currency).toBe("USD");
    });

    it("creates guest cart (no customerId)", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: { currency: "EUR" },
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { customerId: string | null } }>(response);
      expect(json.data.customerId ?? null).toBeNull();
    });

    it("rejects cart creation without cart:create permission", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: { currency: "USD" },
        actor: noPermActor,
      });

      expect(response.status).toBe(403);

      const json = await parseJsonResponse<{ error: { code: string; message: string } }>(response);
      expect(json.error.code).toBe("FORBIDDEN");
    });

    it("creates cart with default currency when not provided", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: {}, // Missing currency - should default to USD
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { id: string; status: string; currency: string } }>(
        response,
      );
      expect(json.data.id).toBeDefined();
      expect(json.data.status).toBe("active");
      expect(json.data.currency).toBe("USD"); // Default currency
    });
  });

  // ─── GET /api/carts/:id ───────────────────────────────────────────────────

  describe("GET /api/carts/:id", () => {
    it("returns cart by ID", async () => {
      // First create a cart
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: { currency: "USD" },
      });
      const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);

      // Then fetch it
      const response = await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/carts/${created.data.id}`,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { id: string; status: string } }>(response);
      expect(json.data.id).toBe(created.data.id);
      expect(json.data.status).toBe("active");
    });

    it("returns 404 for non-existent cart", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/carts/00000000-0000-4000-8000-000000000999",
      });

      expect(response.status).toBe(404);

      const json = await parseJsonResponse<{ error: { code: string; message?: string } }>(response);
      expect(json.error.code).toBe("NOT_FOUND");
    });

    it("returns 400 for invalid UUID format (Zod validation)", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/carts/invalid-uuid",
      });

      expect(response.status).toBe(400);
    });
  });

  // ─── POST /api/carts/:id/items ────────────────────────────────────────────

  describe("POST /api/carts/:id/items", () => {
    let cartId: string;
    let entityId: string;

    beforeEach(async () => {
      // Create a catalog entity first
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: { type: "course", slug: `test-${Date.now()}`, attributes: { title: "Test" } },
        actor: testActor,
      });
      const entity = await parseJsonResponse<{ data: { id: string } }>(createResponse);
      entityId = entity.data.id;

      // Create a cart
      const cartResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: { currency: "USD" },
      });
      const cart = await parseJsonResponse<{ data: { id: string } }>(cartResponse);
      cartId = cart.data.id;
    });

    it("adds item to cart", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/carts/${cartId}/items`,
        body: { entityId, quantity: 1 },
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { entityId: string; quantity: number } }>(response);
      expect(json.data.entityId).toBe(entityId);
      expect(json.data.quantity).toBe(1);
    });

    it("returns 404 when adding to non-existent cart", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts/00000000-0000-4000-8000-000000000999/items",
        body: { entityId, quantity: 1 },
      });

      expect(response.status).toBe(404);
    });

    it("requires cart:update permission", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/carts/${cartId}/items`,
        body: { entityId, quantity: 1 },
        actor: readonlyActor,
      });

      expect(response.status).toBe(403);
    });

    it("validates quantity > 0", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/carts/${cartId}/items`,
        body: { entityId, quantity: 0 },
      });

      // Zod validation rejects quantity < 1 — may return 400 (OpenAPI default) or 422 (custom hook)
      expect([400, 422]).toContain(response.status);
    });
  });

  // ─── PATCH /api/carts/:id/items/:itemId ────────────────────────────────────

  describe("PATCH /api/carts/:id/items/:itemId", () => {
    let cartId: string;
    let itemId: string;
    let entityId: string;

    beforeEach(async () => {
      // Create entity and cart
      const entityResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: { type: "course", slug: `test-${Date.now()}`, attributes: { title: "Test" } },
        actor: testActor,
      });
      const entity = await parseJsonResponse<{ data: { id: string } }>(entityResponse);
      entityId = entity.data.id;

      const cartResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: { currency: "USD" },
      });
      const cart = await parseJsonResponse<{ data: { id: string } }>(cartResponse);
      cartId = cart.data.id;

      // Add an item
      const addItemResponse = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/carts/${cartId}/items`,
        body: { entityId, quantity: 1 },
      });
      const item = await parseJsonResponse<{ data: { id: string } }>(addItemResponse);
      itemId = item.data.id;
    });

    it("updates item quantity", async () => {
      const response = await makeRequest(server, {
        method: "PATCH",
        url: `http://localhost/api/carts/${cartId}/items/${itemId}`,
        body: { quantity: 5 },
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { quantity: number } }>(response);
      expect(json.data.quantity).toBe(5);
    });

    it("returns 404 when cart not found", async () => {
      const response = await makeRequest(server, {
        method: "PATCH",
        url: "http://localhost/api/carts/00000000-0000-4000-8000-000000000999/items/00000000-0000-4000-8000-000000000998",
        body: { quantity: 5 },
      });

      expect(response.status).toBe(404);
    });

    it("returns 404 when item not found", async () => {
      const response = await makeRequest(server, {
        method: "PATCH",
        url: `http://localhost/api/carts/${cartId}/items/00000000-0000-4000-8000-000000000999`,
        body: { quantity: 5 },
      });

      expect(response.status).toBe(404);
    });
  });

  // ─── DELETE /api/carts/:id/items/:itemId ─────────────────────────────────

  describe("DELETE /api/carts/:id/items/:itemId", () => {
    let cartId: string;
    let itemId: string;
    let entityId: string;

    beforeEach(async () => {
      // Setup: create entity, cart, and add item
      const entityResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: { type: "course", slug: `test-${Date.now()}`, attributes: { title: "Test" } },
        actor: testActor,
      });
      const entity = await parseJsonResponse<{ data: { id: string } }>(entityResponse);
      entityId = entity.data.id;

      const cartResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: { currency: "USD" },
      });
      const cart = await parseJsonResponse<{ data: { id: string } }>(cartResponse);
      cartId = cart.data.id;

      const addItemResponse = await makeRequest(server, {
        method: "POST",
        url: `http://localhost/api/carts/${cartId}/items`,
        body: { entityId, quantity: 2 },
      });
      const item = await parseJsonResponse<{ data: { id: string } }>(addItemResponse);
      itemId = item.data.id;
    });

    it("removes item from cart", async () => {
      const response = await makeRequest(server, {
        method: "DELETE",
        url: `http://localhost/api/carts/${cartId}/items/${itemId}`,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { deleted: boolean } }>(response);
      expect(json.data.deleted).toBe(true);

      // Verify item was removed
      const getResponse = await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/carts/${cartId}`,
      });
      const cart = await parseJsonResponse<{ data: { lineItems: unknown[] } }>(getResponse);
      expect(cart.data.lineItems.length).toBe(0);
    });

    it("returns 404 when removing non-existent item", async () => {
      const response = await makeRequest(server, {
        method: "DELETE",
        url: `http://localhost/api/carts/${cartId}/items/00000000-0000-4000-8000-000000000999`,
      });

      expect(response.status).toBe(404);
    });
  });
});
