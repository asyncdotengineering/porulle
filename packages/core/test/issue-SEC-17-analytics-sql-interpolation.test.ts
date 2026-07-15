import { beforeAll, describe, expect, it } from "vitest";
import { orders } from "../src/modules/orders/schema.js";
import type { AnalyticsScope } from "../src/modules/analytics/types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

const ADMIN_SCOPE: AnalyticsScope = { role: "admin" };

describe("SEC-17 — analytics SQL alias safety", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;

  beforeAll(async () => {
    kernel = await createTestKernel();
    const db = kernel.database.db as DrizzleDatabase;

    await db.insert(orders).values({
      organizationId: "org_default",
      orderNumber: "SEC17-ORD",
      status: "confirmed",
      currency: "USD",
      subtotal: 5000,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      grandTotal: 5000,
      placedAt: new Date("2024-06-15T12:00:00Z"),
    });
  });

  it("rejects unknown timeDimensions dimension with validation error", async () => {
    const r = await kernel.services.analytics.query(
      {
        measures: ["Orders.count"],
        timeDimensions: [{
          dimension: 'Orders.placedAt"; DROP TABLE orders; --',
          granularity: "day",
        }],
      },
      ADMIN_SCOPE,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/Unknown time dimension/i);
    }
  });

  it("returns canonical cube.member keys for valid queries", async () => {
    const r = await kernel.services.analytics.query(
      {
        measures: ["Orders.count", "Orders.revenue"],
        dimensions: ["Orders.status"],
        timeDimensions: [{
          dimension: "Orders.placedAt",
          granularity: "month",
        }],
      },
      ADMIN_SCOPE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.rows.length).toBeGreaterThan(0);
    const keys = Object.keys(r.value.rows[0]!);
    expect(keys).toContain("Orders.count");
    expect(keys).toContain("Orders.revenue");
    expect(keys).toContain("Orders.status");
    expect(keys).toContain("Orders.placedAt");
    for (const key of keys) {
      expect(key).toMatch(/^Orders\.[A-Za-z][A-Za-z0-9]*$/);
    }
  });
});
