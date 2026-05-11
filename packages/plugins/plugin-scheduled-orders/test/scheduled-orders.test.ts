import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  testNoPermActor,
  scheduledOrdersAdminActor,
  scheduledOrdersCreatorActor,
} from "./test-utils.js";
import { scheduledOrdersPlugin } from "../src/index.js";

const CUSTOMER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const CART_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

function futureISO(hoursAhead: number): string {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}

function pastISO(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

describe("Scheduled Orders Plugin", () => {
  let app: PluginTestApp["app"];
  let createdId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(scheduledOrdersPlugin());
    app = result.app;
  }, 30_000);

  it("creates a scheduled order for tomorrow -> 201", async () => {
    const res = await app.request("http://localhost/api/scheduled-orders", {
      method: "POST",
      headers: jsonHeaders(scheduledOrdersCreatorActor),
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        cartId: CART_ID,
        scheduledFor: futureISO(24),
        orderType: "pickup",
        pickupLocation: "Main Store",
        notes: "Please have it ready by noon",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    createdId = body.data.id;
    expect(body.data.status).toBe("scheduled");
    expect(body.data.orderType).toBe("pickup");
    expect(body.data.pickupLocation).toBe("Main Store");
  });

  it("lists scheduled orders -> 200", async () => {
    const res = await app.request("http://localhost/api/scheduled-orders", {
      headers: jsonHeaders(scheduledOrdersCreatorActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("gets scheduled order by ID -> 200", async () => {
    const res = await app.request(`http://localhost/api/scheduled-orders/${createdId}`, {
      headers: jsonHeaders(scheduledOrdersCreatorActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(createdId);
  });

  it("cancels a scheduled order -> status=cancelled", async () => {
    const res = await app.request(`http://localhost/api/scheduled-orders/${createdId}/cancel`, {
      method: "POST",
      headers: jsonHeaders(scheduledOrdersCreatorActor),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("cancelled");
  });

  it("cannot cancel already-cancelled order -> error", async () => {
    const res = await app.request(`http://localhost/api/scheduled-orders/${createdId}/cancel`, {
      method: "POST",
      headers: jsonHeaders(scheduledOrdersCreatorActor),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("process due orders -> returns processed list", async () => {
    // Create an order scheduled in the past (due now)
    const createRes = await app.request("http://localhost/api/scheduled-orders", {
      method: "POST",
      headers: jsonHeaders(scheduledOrdersCreatorActor),
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        cartId: CART_ID,
        scheduledFor: pastISO(1),
        orderType: "delivery",
        deliveryAddress: { line1: "123 Main St", city: "Colombo" },
      }),
    });
    expect(createRes.status).toBe(201);

    const res = await app.request("http://localhost/api/scheduled-orders/process-due", {
      method: "POST",
      headers: jsonHeaders(scheduledOrdersAdminActor),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].status).toBe("processing");
  });

  it("no permission -> 403", async () => {
    const res = await app.request("http://localhost/api/scheduled-orders", {
      method: "POST",
      headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        cartId: CART_ID,
        scheduledFor: futureISO(24),
      }),
    });
    expect(res.status).toBe(403);
  });

  it("org isolation: other org sees 0 orders", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff",
      permissions: ["scheduled-orders:read"],
    };
    const res = await app.request("http://localhost/api/scheduled-orders", {
      headers: jsonHeaders(otherOrg),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });
});
