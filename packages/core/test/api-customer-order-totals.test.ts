/**
 * GET /api/customers/:id/orders ?include=totals (#2)
 *
 * Optional lifetime-spend rollup alongside the orders. Refunds/voids are
 * excluded from lifetimeSpend. Without include, the response is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { orders } from "../src/modules/orders/schema.js";
import type { Actor } from "../src/auth/types.js";

const admin: Actor = {
  type: "user",
  userId: "00000000-0000-0000-0000-0000000000ad",
  email: null,
  name: "Admin",
  vendorId: null,
  organizationId: "org_default",
  role: "owner",
  permissions: ["*:*"],
};

describe("GET /api/customers/:id/orders ?include=totals (#2)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kernel: any;
  let cleanup: () => Promise<void>;
  let customerId: string;

  beforeEach(async () => {
    const r = await createTestServer();
    server = r.server;
    kernel = r.kernel;
    cleanup = r.cleanup;

    const cust = await kernel.services.customers.updateByUserId("u-totals", {}, admin);
    customerId = cust.value.id;

    const base = {
      organizationId: "org_default",
      customerId,
      currency: "USD",
      subtotal: 0,
      taxTotal: 0,
      shippingTotal: 0,
    };
    await kernel.database.db.insert(orders).values([
      { ...base, orderNumber: "ORD-A", status: "confirmed", grandTotal: 10000 },
      { ...base, orderNumber: "ORD-B", status: "confirmed", grandTotal: 5000 },
      { ...base, orderNumber: "ORD-C", status: "refunded", grandTotal: 3000 },
    ]);
  });
  afterEach(async () => { await cleanup(); });

  it("returns a flat array by default (no totals)", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/customers/${customerId}/orders`,
      actor: admin,
    });
    expect(res.status).toBe(200);
    const json = await parseJsonResponse<{ data: unknown[] }>(res);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toHaveLength(3);
  });

  it("returns items + totals with ?include=totals, excluding refunds from lifetimeSpend", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/customers/${customerId}/orders?include=totals`,
      actor: admin,
    });
    expect(res.status).toBe(200);
    const json = await parseJsonResponse<{
      data: { items: unknown[]; totals: { count: number; lifetimeSpend: number; averageBasket: number } };
    }>(res);
    expect(json.data.items).toHaveLength(3);
    expect(json.data.totals).toEqual({ count: 3, lifetimeSpend: 15000, averageBasket: 5000 });
  });
});
