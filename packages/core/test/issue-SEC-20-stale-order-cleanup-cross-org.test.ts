import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { orders } from "../src/modules/orders/schema.js";
import { staleOrderCleanupTask } from "../src/modules/orders/stale-order-cleanup.js";
import type { Actor } from "../src/auth/types.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

const DEFAULT_ORG = "org_default";
const NON_DEFAULT_ORG = "org_sec20_b";

const admin = (org: string): Actor => ({
  type: "user",
  userId: `admin_${org}`,
  email: `admin@${org}.test`,
  name: "admin",
  vendorId: null,
  organizationId: org,
  role: "admin",
  permissions: ["*:*"],
});

describe("SEC-20 — stale order cleanup respects per-org context", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let staleNonDefaultOrderId: string;
  let freshDefaultOrderId: string;

  beforeAll(async () => {
    kernel = await createTestKernel();
    await kernel.services.organization.create({
      id: NON_DEFAULT_ORG,
      name: "Store B",
      slug: "sec20-b",
    });

    const stalePlacedAt = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const freshPlacedAt = new Date();

    const [staleNonDefault] = await kernel.database.db
      .insert(orders)
      .values({
        organizationId: NON_DEFAULT_ORG,
        orderNumber: "SEC20-STALE-B",
        status: "pending",
        currency: "USD",
        subtotal: 1000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 1000,
        placedAt: stalePlacedAt,
      })
      .returning({ id: orders.id });
    staleNonDefaultOrderId = staleNonDefault!.id;

    const [freshDefault] = await kernel.database.db
      .insert(orders)
      .values({
        organizationId: DEFAULT_ORG,
        orderNumber: "SEC20-FRESH-A",
        status: "pending",
        currency: "USD",
        subtotal: 2000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 2000,
        placedAt: freshPlacedAt,
      })
      .returning({ id: orders.id });
    freshDefaultOrderId = freshDefault!.id;
  });

  it("cancels stale pending order in a non-default org", async () => {
    const result = await staleOrderCleanupTask.handler({
      input: { thresholdHours: 48 },
      ctx: {
        db: kernel.database.db,
        services: kernel.services,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    });

    expect(result.output.orderIds).toContain(staleNonDefaultOrderId);
    expect(result.output.orderIds).not.toContain(freshDefaultOrderId);

    const nonDefaultRows = await kernel.database.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, staleNonDefaultOrderId));
    expect(nonDefaultRows[0]?.status).toBe("cancelled");

    const freshDefaultRows = await kernel.database.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, freshDefaultOrderId));
    expect(freshDefaultRows[0]?.status).toBe("pending");

    const wrongOrgLookup = await kernel.services.orders.getById(
      staleNonDefaultOrderId,
      admin(DEFAULT_ORG),
    );
    expect(wrongOrgLookup.ok).toBe(false);

    const correctOrgLookup = await kernel.services.orders.getById(
      staleNonDefaultOrderId,
      admin(NON_DEFAULT_ORG),
    );
    expect(correctOrgLookup.ok).toBe(true);
    if (correctOrgLookup.ok) {
      expect(correctOrgLookup.value.status).toBe("cancelled");
    }
  });
});