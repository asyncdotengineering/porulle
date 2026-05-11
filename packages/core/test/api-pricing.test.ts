import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import {
  createTestServer,
  makeRequest,
  testActor,
  readonlyActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

describe("REST API: Pricing", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  let entityId: string;
  let entityIdOrgB: string;

  const otherOrgActor: Actor = {
    ...testActor,
    userId: "pricing-org-b-user",
    organizationId: "org_pricing_route_b",
  };

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
    const db = kernel.database.db as {
      insert: (t: unknown) => {
        values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> };
      };
    };
    await db.insert(organization).values({
      id: otherOrgActor.organizationId,
      name: "Pricing Route B",
      slug: "pricing-route-b",
      createdAt: new Date(),
    }).onConflictDoNothing();

    // Create a test catalog entity
    const createResponse = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: `test-pricing-${Date.now()}`,
        metadata: { title: "Test Pricing Product" },
      },
      actor: testActor,
    });
    const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
    entityId = created.data.id;

    const createResponseOrgB = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: `test-pricing-org-b-${Date.now()}`,
        metadata: { title: "Test Pricing Product B" },
      },
      actor: otherOrgActor,
    });
    const createdOrgB = await parseJsonResponse<{ data: { id: string } }>(createResponseOrgB);
    entityIdOrgB = createdOrgB.data.id;
  });

  // ─── POST /api/pricing/prices ────────────────────────────────────────────────

  describe("POST /api/pricing/prices", () => {
    it("sets base price for entity", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/prices",
        body: {
          entityId,
          currency: "USD",
          amount: 9999,
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { entityId: string; currency: string; amount: number } }>(response);
      expect(json.data.entityId).toBe(entityId);
      expect(json.data.currency).toBe("USD");
      expect(json.data.amount).toBe(9999);
    });

    it("sets price with quantity tier", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/prices",
        body: {
          entityId,
          currency: "USD",
          amount: 8999,
          minQuantity: 10,
          maxQuantity: 49,
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { minQuantity: number; maxQuantity: number } }>(response);
      expect(json.data.minQuantity).toBe(10);
      expect(json.data.maxQuantity).toBe(49);
    });

    it("validates required fields", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/prices",
        body: {
          entityId,
          // Missing currency and amount
        },
        actor: testActor,
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("sets price with customer group", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/prices",
        body: {
          entityId,
          currency: "USD",
          amount: 7999,
          customerGroupId: "wholesale",
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { customerGroupId: string } }>(response);
      expect(json.data.customerGroupId).toBe("wholesale");
    });
  });

  // ─── GET /api/pricing/prices ────────────────────────────────────────────────

  describe("GET /api/pricing/prices", () => {
    beforeEach(async () => {
      // Create some test prices
      await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/prices",
        body: {
          entityId,
          currency: "USD",
          amount: 10000,
        },
        actor: testActor,
      });
    });

    it("returns prices for entity", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/pricing/prices?entityId=${entityId}`,
      });

      expect(response.status).toBe(200);

      // Service returns { prices: [], modifiers: [] }
      const json = await parseJsonResponse<{ data: { prices: unknown[]; modifiers: unknown[] } }>(response);
      expect(json.data.prices.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(json.data.modifiers)).toBe(true);
    });

    it("filters by currency", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/pricing/prices?entityId=${entityId}&currency=USD`,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { prices: unknown[] } }>(response);
      expect(json.data.prices.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by customer group", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: `http://localhost/api/pricing/prices?entityId=${entityId}&customerGroupId=wholesale`,
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { prices: unknown[]; modifiers: unknown[] } }>(response);
      expect(Array.isArray(json.data.prices)).toBe(true);
      expect(Array.isArray(json.data.modifiers)).toBe(true);
    });

    it("returns empty arrays for non-existent entity", async () => {
      const response = await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/pricing/prices?entityId=00000000-0000-0000-0000-000000000999",
      });

      expect(response.status).toBe(200);

      const json = await parseJsonResponse<{ data: { prices: unknown[]; modifiers: unknown[] } }>(response);
      expect(json.data.prices.length).toBe(0);
      expect(json.data.modifiers.length).toBe(0);
    });
  });

  // ─── POST /api/pricing/modifiers ────────────────────────────────────────────

  describe("POST /api/pricing/modifiers", () => {
    it("creates percentage discount modifier", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/modifiers",
        body: {
          name: "VIP 10% Off",
          type: "percentage_discount",
          value: 10,
          priority: 10,
          customerGroupId: "vip",
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { id: string; name: string } }>(response);
      expect(json.data.id).toBeDefined();
      expect(json.data.name).toBe("VIP 10% Off");
    });

    it("creates fixed discount modifier", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/modifiers",
        body: {
          name: "Spring Sale",
          type: "fixed_discount",
          value: 500,
          priority: 20,
          entityId,
        },
        actor: testActor,
      });

      expect(response.status).toBe(201);

      const json = await parseJsonResponse<{ data: { id: string; type: string } }>(response);
      expect(json.data.type).toBe("fixed_discount");
    });

    it("validates required fields", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/modifiers",
        body: {
          // Missing name, type, value
          priority: 10,
        },
        actor: testActor,
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("validates modifier type", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/modifiers",
        body: {
          name: "Invalid Modifier",
          type: "invalid_type",
          value: 10,
          priority: 10,
        },
        actor: testActor,
      });

      expect(response.status).toBeGreaterThanOrEqual(400);

      if (response.status >= 400) {
        const json = await parseJsonResponse<{ error?: { code: string; message?: string } }>(response);
        // Zod validation may return 400 (OpenAPI default) or 422 (custom hook) with different formats
        if (json.error?.code) {
          expect(json.error.code).toBe("VALIDATION_FAILED");
        }
      }
    });

    it("rejects cross-tenant entityId on modifier create", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/modifiers",
        body: {
          name: "Cross Tenant Modifier",
          type: "fixed_discount",
          value: 250,
          entityId,
        },
        actor: otherOrgActor,
      });

      expect(response.status).toBe(422);
      const json = await parseJsonResponse<{ error: { code: string } }>(response);
      expect(json.error.code).toBe("VALIDATION_FAILED");

      const sameOrgResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/pricing/modifiers",
        body: {
          name: "Same Org Modifier",
          type: "fixed_discount",
          value: 250,
          entityId: entityIdOrgB,
        },
        actor: otherOrgActor,
      });
      expect(sameOrgResponse.status).toBe(201);
    });
  });
});
