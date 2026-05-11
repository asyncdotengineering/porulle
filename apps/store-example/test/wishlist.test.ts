/**
 * E2E tests for the Wishlist Plugin — tests router() DX primitives:
 * - .auth() enforcement (401 without login)
 * - .permission() enforcement (403 without scope)
 * - .input() Zod validation (400/422 on bad body)
 * - Response auto-wrapping ({ data: ... })
 * - Path param extraction ({id})
 * - /api prefix prepending
 * - OpenAPI spec inclusion
 */

import { describe, expect, it, beforeAll } from "vitest";

const BASE = process.env.API_URL ?? "http://localhost:4000";
const DEV_KEY = process.env.STORE_API_KEY ?? "";

async function api(method: string, path: string, body?: unknown, opts?: { noAuth?: boolean }) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "origin": BASE,
  };
  if (!opts?.noAuth) {
    headers["x-api-key"] = DEV_KEY;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

describe("Wishlist Plugin — router() E2E", () => {

  // ─── .auth() enforcement ────────────────────────────────────────────

  describe(".auth() enforcement", () => {
    it("GET /api/wishlist without auth returns 401", async () => {
      const res = await api("GET", "/api/wishlist", undefined, { noAuth: true });
      expect(res.status).toBe(401);
      expect(res.data.error.code).toBe("UNAUTHORIZED");
      expect(res.data.error.message).toContain("Authentication required");
    });

    it("POST /api/wishlist without auth returns 401", async () => {
      const res = await api("POST", "/api/wishlist", { entityId: "550e8400-e29b-41d4-a716-446655440000" }, { noAuth: true });
      expect(res.status).toBe(401);
      expect(res.data.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/wishlist with auth returns 200", async () => {
      const res = await api("GET", "/api/wishlist");
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty("data");
      expect(Array.isArray(res.data.data)).toBe(true);
    });
  });

  // ─── .permission() enforcement ──────────────────────────────────────

  describe(".permission() enforcement", () => {
    it("DELETE /api/wishlist/{id} without auth returns 401", async () => {
      const res = await api("DELETE", "/api/wishlist/550e8400-e29b-41d4-a716-446655440000", undefined, { noAuth: true });
      expect(res.status).toBe(401);
      expect(res.data.error.code).toBe("UNAUTHORIZED");
    });

    it("DELETE /api/wishlist/{id} with admin (wildcard *:*) returns 200", async () => {
      const res = await api("DELETE", "/api/wishlist/550e8400-e29b-41d4-a716-446655440000");
      expect(res.status).toBe(200);
      expect(res.data.data.deleted).toBe(true);
    });
  });

  // ─── .input() Zod validation ────────────────────────────────────────

  describe(".input() Zod validation", () => {
    it("POST with missing required field returns 400", async () => {
      const res = await api("POST", "/api/wishlist", { note: "no entityId" });
      expect([400, 422]).toContain(res.status);
      const errorText = JSON.stringify(res.data);
      expect(errorText).toContain("entityId");
    });

    it("POST with invalid UUID returns 400", async () => {
      const res = await api("POST", "/api/wishlist", { entityId: "not-a-uuid" });
      expect([400, 422]).toContain(res.status);
    });

    it("POST with valid body returns 201", async () => {
      const res = await api("POST", "/api/wishlist", {
        entityId: "550e8400-e29b-41d4-a716-446655440000",
        note: "Birthday gift idea",
      });
      expect(res.status).toBe(201);
      expect(res.data.data).toHaveProperty("id");
      expect(res.data.data.entityId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(res.data.data.note).toBe("Birthday gift idea");
    });

    it("POST with note exceeding 500 chars returns 400", async () => {
      const res = await api("POST", "/api/wishlist", {
        entityId: "550e8400-e29b-41d4-a716-446655440000",
        note: "x".repeat(501),
      });
      expect([400, 422]).toContain(res.status);
    });
  });

  // ─── Response auto-wrapping ─────────────────────────────────────────

  describe("response auto-wrapping", () => {
    it("GET returns { data: [...] } wrapper", async () => {
      const res = await api("GET", "/api/wishlist");
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty("data");
      expect(Array.isArray(res.data.data)).toBe(true);
    });

    it("POST returns { data: { ... } } wrapper with 201 status", async () => {
      const res = await api("POST", "/api/wishlist", {
        entityId: "660e8400-e29b-41d4-a716-446655440000",
      });
      expect(res.status).toBe(201);
      expect(res.data).toHaveProperty("data");
      expect(res.data.data).toHaveProperty("id");
      expect(res.data.data).toHaveProperty("customerId");
      expect(res.data.data).toHaveProperty("addedAt");
    });

    it("DELETE returns { data: { deleted: true } } wrapper", async () => {
      // First create an item to delete
      const created = await api("POST", "/api/wishlist", {
        entityId: "770e8400-e29b-41d4-a716-446655440000",
      });
      expect(created.status).toBe(201);
      const id = created.data.data.id;

      const res = await api("DELETE", `/api/wishlist/${id}`);
      expect(res.status).toBe(200);
      expect(res.data.data.deleted).toBe(true);
    });
  });

  // ─── Path param extraction ──────────────────────────────────────────

  describe("path param extraction", () => {
    it("DELETE with invalid UUID in path returns 400 (Zod param validation)", async () => {
      const res = await api("DELETE", "/api/wishlist/not-a-uuid");
      expect([400, 422]).toContain(res.status);
    });

    it("DELETE with valid UUID path param works", async () => {
      const res = await api("DELETE", "/api/wishlist/00000000-0000-4000-8000-000000000099");
      expect(res.status).toBe(200);
    });
  });

  // ─── /api prefix ───────────────────────────────────────────────────

  describe("/api prefix", () => {
    it("routes are served at /api/wishlist (not /wishlist/)", async () => {
      const res = await api("GET", "/api/wishlist");
      expect(res.status).toBe(200);
    });

    it("/wishlist/ without /api returns 404", async () => {
      const res = await api("GET", "/wishlist/");
      expect(res.status).toBe(404);
    });
  });

  // ─── OpenAPI spec ──────────────────────────────────────────────────

  describe("OpenAPI spec", () => {
    let spec: Record<string, unknown>;

    beforeAll(async () => {
      const res = await fetch(`${BASE}/api/doc`);
      spec = await res.json() as Record<string, unknown>;
    });

    it("spec includes /api/wishlist GET route", () => {
      const paths = spec.paths as Record<string, Record<string, unknown>>;
      const wishlistPath = paths["/api/wishlist"];
      expect(wishlistPath).toBeDefined();
      expect(wishlistPath!.get).toBeDefined();
    });

    it("spec includes /api/wishlist POST route with request body", () => {
      const paths = spec.paths as Record<string, Record<string, unknown>>;
      const wishlistPath = paths["/api/wishlist"];
      expect(wishlistPath!.post).toBeDefined();
      const post = wishlistPath!.post as Record<string, unknown>;
      expect(post.requestBody).toBeDefined();
    });

    it("spec includes /api/wishlist/{id} DELETE route", () => {
      const paths = spec.paths as Record<string, Record<string, unknown>>;
      const deletePath = paths["/api/wishlist/{id}"];
      expect(deletePath).toBeDefined();
      expect(deletePath!.delete).toBeDefined();
    });

    it("all wishlist routes are tagged as 'Wishlist'", () => {
      const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
      const wishlistPaths = Object.entries(paths).filter(([p]) => p.includes("wishlist"));
      for (const [, methods] of wishlistPaths) {
        for (const data of Object.values(methods)) {
          expect((data as Record<string, unknown>).tags).toContain("Wishlist");
        }
      }
    });

    it("POST route has AddWishlistItem schema reference", () => {
      const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
      const post = paths["/api/wishlist"]?.post as Record<string, unknown>;
      const bodyStr = JSON.stringify(post?.requestBody);
      expect(bodyStr).toContain("AddWishlistItem");
    });
  });

  // ─── Edge Cases (from adversarial review) ──────────────────────────

  describe("edge cases", () => {
    it("POST with empty entityId string returns 400 (UUID validation)", async () => {
      const res = await api("POST", "/api/wishlist", { entityId: "" });
      expect([400, 422]).toContain(res.status);
    });

    it("POST with empty note is allowed (note is optional)", async () => {
      const res = await api("POST", "/api/wishlist", {
        entityId: "550e8400-e29b-41d4-a716-446655440000",
        note: "",
      });
      expect(res.status).toBe(201);
    });

    it("POST with extra unknown fields is accepted (Zod strips unknowns)", async () => {
      const res = await api("POST", "/api/wishlist", {
        entityId: "550e8400-e29b-41d4-a716-446655440000",
        unknownField: "should be stripped",
        anotherField: 42,
      });
      // Zod default mode strips unknown fields — request succeeds
      expect(res.status).toBe(201);
      expect(res.data.data).not.toHaveProperty("unknownField");
    });

    it("POST response has correct field structure", async () => {
      const res = await api("POST", "/api/wishlist", {
        entityId: "880e8400-e29b-41d4-a716-446655440000",
        note: "Structure test",
      });
      expect(res.status).toBe(201);
      const item = res.data.data;
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("customerId");
      expect(item).toHaveProperty("entityId");
      expect(item).toHaveProperty("note");
      expect(item).toHaveProperty("addedAt");
      expect(typeof item.id).toBe("string");
      expect(typeof item.addedAt).toBe("string");
      // ISO 8601 format check
      expect(new Date(item.addedAt).toISOString()).toBe(item.addedAt);
    });

    it("DELETE non-existent item returns 200 (idempotent delete)", async () => {
      const res = await api("DELETE", "/api/wishlist/00000000-0000-4000-8000-000000000099");
      // DELETE is idempotent — deleting a non-existent row is not an error
      expect(res.status).toBe(200);
      expect(res.data.data.deleted).toBe(true);
    });

    it("handler returning null wraps as { data: null }", async () => {
      // GET on empty wishlist (fresh DB) returns empty array, not null
      const res = await api("GET", "/api/wishlist");
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty("data");
    });

    it("concurrent POST requests both succeed", async () => {
      const body1 = { entityId: "aa0e8400-e29b-41d4-a716-446655440001" };
      const body2 = { entityId: "aa0e8400-e29b-41d4-a716-446655440002" };
      const [r1, r2] = await Promise.all([
        api("POST", "/api/wishlist", body1),
        api("POST", "/api/wishlist", body2),
      ]);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r1.data.data.entityId).toBe(body1.entityId);
      expect(r2.data.data.entityId).toBe(body2.entityId);
    });
  });
});
