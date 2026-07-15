import { describe, expect, it, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, testAdminActor, TEST_ORG_ID } from "./test-utils.js";
import { giftCardPlugin } from "../src/index.js";

// A gift-cards admin belonging to a DIFFERENT organization than testAdminActor.
const foreignAdmin: Actor = {
  type: "user",
  userId: "gc-foreign-admin",
  email: "foreign@test.local",
  name: "Foreign Admin",
  vendorId: null,
  organizationId: "org_gc_foreign",
  role: "staff",
  permissions: ["gift-cards:admin"],
};

describe("VAPT: gift-card cross-tenant isolation", () => {
  let app: PluginTestApp["app"];
  let cardId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(giftCardPlugin());
    app = result.app;

    const res = await app.request("http://localhost/api/gift-cards", {
      method: "POST",
      headers: jsonHeaders(testAdminActor),
      body: JSON.stringify({ amount: 5000, currency: "USD" }),
    });
    expect(res.status).toBe(201);
    cardId = (await res.json()).data.id;
    expect(cardId).toBeTruthy();
    expect(testAdminActor.organizationId).toBe(TEST_ORG_ID);
  }, 30_000);

  it("GC-02: a foreign-org admin cannot read another tenant's card (404, not 500)", async () => {
    const res = await app.request(`http://localhost/api/gift-cards/${cardId}`, {
      headers: jsonHeaders(foreignAdmin),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("GC-04: a foreign-org admin cannot disable another tenant's card", async () => {
    const res = await app.request(`http://localhost/api/gift-cards/${cardId}/disable`, {
      method: "POST",
      headers: jsonHeaders(foreignAdmin),
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("GC-05: a foreign-org admin cannot adjust another tenant's card", async () => {
    const res = await app.request(`http://localhost/api/gift-cards/${cardId}/adjust`, {
      method: "POST",
      headers: jsonHeaders(foreignAdmin),
      body: JSON.stringify({ delta: -1000, note: "vapt" }),
    });
    expect(res.status).toBe(404);
  });

  it("GC-03: a foreign-org admin's list does not include another tenant's card", async () => {
    const res = await app.request("http://localhost/api/gift-cards", {
      headers: jsonHeaders(foreignAdmin),
    });
    expect(res.status).toBe(200);
    const ids = ((await res.json()).data as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(cardId);
  });

  it("the owning-org admin can still read its own card", async () => {
    const res = await app.request(`http://localhost/api/gift-cards/${cardId}`, {
      headers: jsonHeaders(testAdminActor),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBe(cardId);
  });
});
