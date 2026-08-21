import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import type { Kernel } from "../src/runtime/kernel.js";
import { createTestServer, testActor } from "../src/test-utils/rest-api-test-utils.js";

// A POS operator sells items the storefront never publishes. The catalog read
// policy hides unpublished entities from unprivileged readers, and order
// creation validates that every line item belongs to the order's organization.
// That validation is an internal invariant check: routing it through the
// caller-facing read made a draft entity unsellable by any operator without
// catalog:update, which broke layaway completion.
const posOperator: Actor = {
  type: "user",
  userId: "draft-visibility-operator",
  email: "operator@draft-visibility.test",
  name: "POS Operator",
  vendorId: null,
  organizationId: "org_default",
  role: "staff",
  permissions: ["orders:create", "orders:read", "orders:manage"],
};

const customer: Actor = {
  type: "user",
  userId: "draft-visibility-customer",
  email: "customer@draft-visibility.test",
  name: "Customer",
  vendorId: null,
  organizationId: "org_default",
  role: "customer",
  permissions: ["catalog:read", "orders:create", "orders:read:own"],
};

describe("order line items and unpublished catalog entities", () => {
  let kernel: Kernel;
  let cleanup: () => Promise<void>;
  let draftEntityId: string;

  beforeAll(async () => {
    const testServer = await createTestServer();
    kernel = testServer.kernel;
    cleanup = testServer.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `draft-visibility-${crypto.randomUUID()}`,
        attributes: { title: "Unlisted bridal saree" },
        metadata: {},
      },
      testActor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) throw entity.error;
    draftEntityId = entity.value.id;
    expect(entity.value.status).toBe("draft");

    const stock = await kernel.services.inventory.adjust(
      { entityId: draftEntityId, adjustment: 5, reason: "draft visibility stock" },
      testActor,
    );
    expect(stock.ok).toBe(true);
  });

  function orderInput() {
    return {
      currency: "USD",
      subtotal: 5000,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: 5000,
      lineItems: [
        {
          entityId: draftEntityId,
          entityType: "product",
          title: "Unlisted bridal saree",
          quantity: 1,
          unitPrice: 5000,
          totalPrice: 5000,
        },
      ],
    };
  }

  it("lets an operator without catalog:update sell an unpublished entity", async () => {
    const order = await kernel.services.orders.create(orderInput(), posOperator);
    expect(order.ok).toBe(true);
    if (!order.ok) throw order.error;
    expect(order.value.lineItems[0]?.entityId).toBe(draftEntityId);
  });

  it("refuses an unpublished entity for a customer placing their own order", async () => {
    const order = await kernel.services.orders.create(orderInput(), customer);
    expect(order.ok).toBe(false);
    expect(order.error?.message).toContain("does not belong to this organization");
  });
});
