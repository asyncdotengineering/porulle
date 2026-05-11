import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { sellableEntities } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, testNoPermActor, wishlistUserActor, wishlistAdminActor, TEST_ORG_ID } from "./test-utils.js";
import { wishlistPlugin } from "../src/index.js";

const ENTITY_A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const ENTITY_B = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

describe("Wishlist Plugin", () => {
  let app: PluginTestApp["app"];
  let itemId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(wishlistPlugin());
    app = result.app;

    // Seed sellable_entities to satisfy FK constraints. The wishlist table has
    // FK references to organization + sellable_entities (multi-tenant
    // isolation), so these rows must exist before the route POSTs against
    // them. Drizzle-typed insert — column rename in the source schema would
    // surface here at compile time.
    await result.db.insert(sellableEntities).values([
      { id: ENTITY_A, organizationId: TEST_ORG_ID, type: "product", slug: "a-prod", status: "active", isVisible: true },
      { id: ENTITY_B, organizationId: TEST_ORG_ID, type: "product", slug: "b-prod", status: "active", isVisible: true },
    ]).onConflictDoNothing();
  }, 30_000);

  it("adds item to wishlist -> 201", async () => {
    const res = await app.request("http://localhost/api/wishlist", {
      method: "POST", headers: jsonHeaders(wishlistUserActor),
      body: JSON.stringify({ entityId: ENTITY_A }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    itemId = body.data.id;
    expect(body.data.userId).toBe("wishlist-user-1");
    expect(body.data.organizationId).toBe(TEST_ORG_ID);
  });

  it("rejects duplicate item -> error", async () => {
    const res = await app.request("http://localhost/api/wishlist", {
      method: "POST", headers: jsonHeaders(wishlistUserActor),
      body: JSON.stringify({ entityId: ENTITY_A }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("lists my wishlist -> 200", async () => {
    const res = await app.request("http://localhost/api/wishlist", { headers: jsonHeaders(wishlistUserActor) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(1);
  });

  it("adds second item with note -> 201", async () => {
    const res = await app.request("http://localhost/api/wishlist", {
      method: "POST", headers: jsonHeaders(wishlistUserActor),
      body: JSON.stringify({ entityId: ENTITY_B, note: "Birthday gift idea" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.note).toBe("Birthday gift idea");
  });

  it("removes item -> 200", async () => {
    const res = await app.request(`http://localhost/api/wishlist/${itemId}`, {
      method: "DELETE", headers: jsonHeaders(wishlistUserActor),
    });
    expect(res.status).toBe(200);

    // Verify removed
    const listRes = await app.request("http://localhost/api/wishlist", { headers: jsonHeaders(wishlistUserActor) });
    expect((await listRes.json()).data.length).toBe(1);
  });

  it("unauthenticated -> 401", async () => {
    const res = await app.request("http://localhost/api/wishlist", {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("org isolation: other org user sees empty wishlist", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "wishlist-user-1", email: "user@test.local", name: "Same User",
      vendorId: null, organizationId: "org_other", role: "customer",
      permissions: ["wishlist:read", "wishlist:write"],
    };
    const res = await app.request("http://localhost/api/wishlist", { headers: jsonHeaders(otherOrg) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });
});
