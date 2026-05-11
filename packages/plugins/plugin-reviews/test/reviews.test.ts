import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  testNoPermActor,
  reviewsAdminActor,
  reviewsCustomerActor,
  reviewsWriterActor,
  reviewsReaderActor,
} from "./test-utils.js";
import { reviewsPlugin } from "../src/index.js";

const ENTITY_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const ORDER_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const CUSTOMER_ID = "c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f";

describe("Reviews Plugin", () => {
  let app: PluginTestApp["app"];
  let reviewId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(reviewsPlugin());
    app = result.app;
  }, 30_000);

  it("submits a review with rating 5 -> 201", async () => {
    const res = await app.request("http://localhost/api/reviews", {
      method: "POST",
      headers: jsonHeaders(reviewsWriterActor),
      body: JSON.stringify({
        entityId: ENTITY_ID,
        customerId: CUSTOMER_ID,
        rating: 5,
        title: "Great product",
        body: "Highly recommended!",
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    reviewId = json.data.id;
    expect(json.data.rating).toBe(5);
    expect(json.data.status).toBe("pending");
    expect(json.data.isVerified).toBe(false);
    expect(json.data.isPublished).toBe(false);
  });

  it("rejects rating 0 -> error", async () => {
    const res = await app.request("http://localhost/api/reviews", {
      method: "POST",
      headers: jsonHeaders(reviewsWriterActor),
      body: JSON.stringify({ entityId: ENTITY_ID, rating: 0 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects rating 6 -> error", async () => {
    const res = await app.request("http://localhost/api/reviews", {
      method: "POST",
      headers: jsonHeaders(reviewsWriterActor),
      body: JSON.stringify({ entityId: ENTITY_ID, rating: 6 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("submits with orderId -> isVerified=true", async () => {
    const res = await app.request("http://localhost/api/reviews", {
      method: "POST",
      headers: jsonHeaders(reviewsWriterActor),
      body: JSON.stringify({
        entityId: ENTITY_ID,
        orderId: ORDER_ID,
        rating: 4,
        title: "Verified purchase",
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.isVerified).toBe(true);
  });

  it("ignores spoofed customerId for customer-role actor", async () => {
    const spoofedCustomerId = "11111111-1111-4111-8111-111111111111";
    const res = await app.request("http://localhost/api/reviews", {
      method: "POST",
      headers: jsonHeaders(reviewsCustomerActor),
      body: JSON.stringify({
        entityId: ENTITY_ID,
        customerId: spoofedCustomerId,
        rating: 4,
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.customerId).not.toBe(spoofedCustomerId);
  });

  it("lists reviews for entity -> returns reviews", async () => {
    const res = await app.request(
      `http://localhost/api/reviews/entity/${ENTITY_ID}`,
      { headers: jsonHeaders(reviewsReaderActor) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.length).toBeGreaterThanOrEqual(2);
  });

  it("summary: averageRating + distribution", async () => {
    const res = await app.request(
      `http://localhost/api/reviews/entity/${ENTITY_ID}/summary`,
      { headers: jsonHeaders(reviewsReaderActor) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.averageRating).toBeGreaterThan(0);
    expect(json.data.totalCount).toBeGreaterThanOrEqual(2);
    expect(json.data.distribution).toBeDefined();
    expect(json.data.distribution[5]).toBeGreaterThanOrEqual(1);
    expect(json.data.distribution[4]).toBeGreaterThanOrEqual(1);
  });

  it("approve -> status=approved, isPublished=true", async () => {
    const res = await app.request(
      `http://localhost/api/reviews/${reviewId}/approve`,
      { method: "PATCH", headers: jsonHeaders(reviewsAdminActor) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("approved");
    expect(json.data.isPublished).toBe(true);
  });

  it("reject -> status=rejected", async () => {
    // Submit a new review to reject
    const submitRes = await app.request("http://localhost/api/reviews", {
      method: "POST",
      headers: jsonHeaders(reviewsWriterActor),
      body: JSON.stringify({ entityId: ENTITY_ID, rating: 1, title: "Bad" }),
    });
    const submitJson = await submitRes.json();
    const rejectId = submitJson.data.id;

    const res = await app.request(
      `http://localhost/api/reviews/${rejectId}/reject`,
      { method: "PATCH", headers: jsonHeaders(reviewsAdminActor) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("rejected");
  });

  it("reply -> response field set", async () => {
    const res = await app.request(
      `http://localhost/api/reviews/${reviewId}/reply`,
      {
        method: "POST",
        headers: jsonHeaders(reviewsAdminActor),
        body: JSON.stringify({
          response: "Thank you for your feedback!",
          responseBy: "Store Owner",
        }),
      },
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.response).toBe("Thank you for your feedback!");
    expect(json.data.responseBy).toBe("Store Owner");
    expect(json.data.responseAt).toBeDefined();
  });

  it("no permission -> 403", async () => {
    const res = await app.request("http://localhost/api/reviews", {
      method: "POST",
      headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ entityId: ENTITY_ID, rating: 3 }),
    });
    expect(res.status).toBe(403);
  });

  it("org isolation: different org sees 0 reviews", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff",
      permissions: ["reviews:read"],
    };
    const res = await app.request(
      `http://localhost/api/reviews/entity/${ENTITY_ID}`,
      { headers: jsonHeaders(otherOrg) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });
});
