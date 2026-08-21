import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import type { Kernel } from "../src/runtime/kernel.js";
import { createTestServer } from "../src/test-utils/rest-api-test-utils.js";

const FOREIGN_ORG_ID = "org_draft_visibility_foreign";

// A POS operator sells items the storefront never publishes. The catalog read
// policy hides unpublished entities from unprivileged readers, and order
// creation validates that every line item belongs to the order's organization.
// That validation is an internal invariant check: routing it through the
// caller-facing read made a draft entity unsellable by any operator without
// catalog:read:unpublished, which broke layaway completion.
const posOperator: Actor = {
  type: "user",
  userId: "draft-visibility-operator",
  email: "operator@draft-visibility.test",
  name: "POS Operator",
  vendorId: null,
  organizationId: "org_default",
  role: "custom_pos_operator",
  permissions: [
    "catalog:create",
    "catalog:read:unpublished",
    "inventory:adjust",
    "orders:create",
    "orders:read",
    "orders:manage",
  ],
};

const onBehalfOperator: Actor = {
  ...posOperator,
  userId: "draft-visibility-on-behalf-operator",
  role: "custom_clienteling_operator",
  permissions: [...posOperator.permissions, "orders:create:on-behalf"],
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
  let foreignCustomerId: string;
  let crossTenantCustomerId: string;

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
      posOperator,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) throw entity.error;
    draftEntityId = entity.value.id;
    expect(entity.value.status).toBe("draft");

    const stock = await kernel.services.inventory.adjust(
      { entityId: draftEntityId, adjustment: 5, reason: "draft visibility stock" },
      posOperator,
    );
    expect(stock.ok).toBe(true);

    const foreignOrganization = await kernel.services.organization.create({
      id: FOREIGN_ORG_ID,
      name: "Draft Visibility Foreign Organization",
      slug: "draft-visibility-foreign",
    });
    expect(foreignOrganization.ok).toBe(true);

    const foreignCustomer = await kernel.services.customers.getByUserId(
      "draft-visibility-foreign-customer",
      posOperator,
    );
    expect(foreignCustomer.ok).toBe(true);
    if (!foreignCustomer.ok) throw foreignCustomer.error;
    foreignCustomerId = foreignCustomer.value.id;

    const crossTenantCustomer = await kernel.services.customers.getByUserId(
      "draft-visibility-cross-tenant-customer",
      { ...onBehalfOperator, organizationId: FOREIGN_ORG_ID },
    );
    expect(crossTenantCustomer.ok).toBe(true);
    if (!crossTenantCustomer.ok) throw crossTenantCustomer.error;
    crossTenantCustomerId = crossTenantCustomer.value.id;
  });

  function orderInput(customerId?: string) {
    return {
      ...(customerId !== undefined ? { customerId } : {}),
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

  it("lets an operator with catalog:read:unpublished and no catalog:update create and sell an unpublished entity", async () => {
    const order = await kernel.services.orders.create(orderInput(), posOperator);
    expect(order.ok).toBe(true);
    if (!order.ok) throw order.error;
    expect(order.value.lineItems[0]?.entityId).toBe(draftEntityId);
  });

  it("does not let a customer actor read or transact against an unpublished entity", async () => {
    const read = await kernel.services.catalog.getById(draftEntityId, undefined, customer);
    expect(read.ok).toBe(false);

    const order = await kernel.services.orders.create(orderInput(), customer);
    expect(order.ok).toBe(false);
  });

  it("does not attribute to a customer without orders:create:on-behalf", async () => {
    const order = await kernel.services.orders.create(
      orderInput(foreignCustomerId),
      posOperator,
    );

    expect(order.ok).toBe(true);
    if (!order.ok) throw order.error;
    expect(order.value.customerId).toBeNull();
  });

  it("lets an explicit orders:create:on-behalf permission name a foreign customer profile", async () => {
    const order = await kernel.services.orders.create(
      orderInput(foreignCustomerId),
      onBehalfOperator,
    );

    expect(order.ok).toBe(true);
    if (!order.ok) throw order.error;
    expect(order.value.customerId).toBe(foreignCustomerId);
  });

  it("rejects an on-behalf customer profile from another organization", async () => {
    const order = await kernel.services.orders.create(
      orderInput(crossTenantCustomerId),
      onBehalfOperator,
    );

    expect(order.ok).toBe(false);
    if (order.ok) throw new Error("expected a cross-organization customer to be rejected");
    expect(order.error.message).toContain("customerId must reference a customer in this organization");
  });

  it("refuses an unpublished entity for a customer placing their own order", async () => {
    const order = await kernel.services.orders.create(orderInput(), customer);
    expect(order.ok).toBe(false);
    if (order.ok) throw new Error("expected the draft entity to be refused");
    expect(order.error.message).toContain("does not belong to this organization");
  });
});
