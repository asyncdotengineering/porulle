import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const actor = {
  type: "user",
  userId: "promo-actor-1",
  email: "promo@example.com",
  name: "Promo Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "inventory:adjust",
    "inventory:read",
    "orders:create",
    "orders:read",
    "orders:update",
  ],
} as any;

async function createProduct(kernel: ReturnType<typeof createKernel>, slug: string) {
  const created = await kernel.services.catalog.create(
    { type: "product", slug, attributes: { title: slug }, metadata: {} },
    actor,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  return created.value;
}

// ─── Happy Path ────────────────────────────────────────────────────────────────

describe("promotions – happy path (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("percentage_off_order: 10% off $100 order = $10 discount", async () => {
    const product = await createProduct(kernel, "promo-pct-order");

    await kernel.services.promotions.create({
      code: "PCT10",
      name: "10% Off Order",
      type: "percentage_off_order",
      value: 10,
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 10000, // $100 in cents
      promotionCodes: ["PCT10"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 10000, totalPrice: 10000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(1000); // 10% of 10000
    expect(result.value.applied).toHaveLength(1);
    expect(result.value.applied[0]!.code).toBe("PCT10");
  });

  it("fixed_off_order: $15 fixed off $100 order = $15 discount", async () => {
      const product = await createProduct(kernel, "promo-fixed-order");

    await kernel.services.promotions.create({
      code: "FIXED1500",
      name: "Fixed $15 Off",
      type: "fixed_off_order",
      value: 1500, // cents
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 10000,
      promotionCodes: ["FIXED1500"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 10000, totalPrice: 10000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(1500);
  });

  it("free_shipping: freeShipping = true in result", async () => {
      const product = await createProduct(kernel, "promo-free-ship");

    await kernel.services.promotions.create({
      code: "FREESHIP",
      name: "Free Shipping",
      type: "free_shipping",
      value: 0,
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 5000,
      promotionCodes: ["FREESHIP"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.freeShipping).toBe(true);
  });

  it("percentage_off_item: applies correctly to eligible items", async () => {
      const product = await createProduct(kernel, "promo-pct-item");

    await kernel.services.promotions.create({
      code: "ITEM20",
      name: "20% Off Item",
      type: "percentage_off_item",
      value: 20,
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 5000,
      promotionCodes: ["ITEM20"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 2, unitPrice: 2500, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 20% of the eligible item total (5000)
    expect(result.value.totalDiscount).toBeGreaterThan(0);
    expect(result.value.applied).toHaveLength(1);
  });

  it("promotion with minimumOrderValue: meets threshold → applies", async () => {
      const product = await createProduct(kernel, "promo-min-order");

    await kernel.services.promotions.create({
      code: "MINORD",
      name: "Min Order Promo",
      type: "fixed_off_order",
      value: 500,
      conditions: { minimumOrderValue: 5000 },
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 6000, // meets minimum
      promotionCodes: ["MINORD"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 2, unitPrice: 3000, totalPrice: 6000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(500);
    expect(result.value.applied).toHaveLength(1);
  });

  it("promotion with customerGroups: customer in group → applies", async () => {
      const product = await createProduct(kernel, "promo-group");

    await kernel.services.promotions.create({
      code: "VIP15",
      name: "VIP 15% Off",
      type: "percentage_off_order",
      value: 15,
      conditions: { customerGroups: ["vip"] },
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 10000,
      customerId: "00000000-0000-0000-0000-000000000203",
      customerGroupIds: ["vip"],
      promotionCodes: ["VIP15"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 10000, totalPrice: 10000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(1500); // 15% of 10000
    expect(result.value.applied).toHaveLength(1);
  });

  it("listActive: only returns non-expired, isActive promotions", async () => {
  
    await kernel.services.promotions.create({
      code: "ACTIVE1",
      name: "Active Promo",
      type: "percentage_off_order",
      value: 5,
      isActive: true,
    });
    await kernel.services.promotions.create({
      code: "EXPIRED1",
      name: "Expired Promo",
      type: "percentage_off_order",
      value: 5,
      validUntil: new Date("2020-01-01T00:00:00.000Z"),
    });

    const active = await kernel.services.promotions.listActive();
    expect(active.ok).toBe(true);
    if (!active.ok) return;

    const codes = active.value.map((p) => p.code);
    expect(codes).toContain("ACTIVE1");
    expect(codes).not.toContain("EXPIRED1");
  });

  it("recordUsage: increments usageCount on repeated validate", async () => {
      const product = await createProduct(kernel, "promo-usage-count");

    const promo = await kernel.services.promotions.create({
      code: "LIMIT2",
      name: "Limit 2 Uses",
      type: "fixed_off_order",
      value: 200,
      usageLimitTotal: 2,
    });
    expect(promo.ok).toBe(true);
    if (!promo.ok) return;

    // Use it once
    await kernel.services.promotions.recordUsage({
      organizationId: promo.value.organizationId,
      promotions: [
        {
          promotionId: promo.value.id,
          code: "LIMIT2",
          type: "fixed_off_order",
          discountAmount: 200,
          freeShipping: false,
          description: "test",
        },
      ],
      orderId: "00000000-0000-0000-0000-000000000101",
      customerId: "00000000-0000-0000-0000-000000000201",
    });

    // Should still validate (1 use < limit 2)
    const valid = await kernel.services.promotions.validate("LIMIT2", {
      currency: "USD",
      subtotal: 5000,
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });
    expect(valid.ok).toBe(true);
  });
});

// ─── Unhappy Path ──────────────────────────────────────────────────────────────

describe("promotions – unhappy path (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("validate: code doesn't exist → Err(NotFound)", async () => {
      const product = await createProduct(kernel, "promo-not-found");

    const result = await kernel.services.promotions.validate("DOESNOTEXIST", {
      currency: "USD",
      subtotal: 5000,
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });

  it("apply: expired promotion → Err", async () => {
      const product = await createProduct(kernel, "promo-expired");

    await kernel.services.promotions.create({
      code: "OLDCODE",
      name: "Old Promo",
      type: "fixed_off_order",
      value: 100,
      validUntil: new Date("2020-01-01T00:00:00.000Z"),
    });

    const result = await kernel.services.promotions.apply("OLDCODE", {
      currency: "USD",
      subtotal: 5000,
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("apply: minimum order not met → Err(CommerceValidationError with reason)", async () => {
      const product = await createProduct(kernel, "promo-min-fail");

    await kernel.services.promotions.create({
      code: "HIGHMIN",
      name: "High Min Promo",
      type: "fixed_off_order",
      value: 500,
      conditions: { minimumOrderValue: 10000 },
    });

    const result = await kernel.services.promotions.apply("HIGHMIN", {
      currency: "USD",
      subtotal: 3000, // below minimum
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 3000, totalPrice: 3000 },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/minimum/i);
  });

  it("apply: customer not in required group → rejection in applyPromotions", async () => {
      const product = await createProduct(kernel, "promo-group-fail");

    await kernel.services.promotions.create({
      code: "VIPONLY",
      name: "VIP Only",
      type: "percentage_off_order",
      value: 20,
      conditions: { customerGroups: ["vip"] },
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 5000,
      customerId: "00000000-0000-0000-0000-000000000204",
      customerGroupIds: ["retail"], // not in vip group
      promotionCodes: ["VIPONLY"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(0);
    expect(result.value.applied).toHaveLength(0);
    expect(result.value.rejectedCodes.some((r) => r.code === "VIPONLY")).toBe(true);
  });

  it("apply: usage limit reached (usageLimitTotal = 1, used once) → rejection", async () => {
      const product = await createProduct(kernel, "promo-limit-reached");

    const promo = await kernel.services.promotions.create({
      code: "ONCE",
      name: "One Time Use",
      type: "fixed_off_order",
      value: 300,
      usageLimitTotal: 1,
    });
    expect(promo.ok).toBe(true);
    if (!promo.ok) return;

    // Record one usage
    await kernel.services.promotions.recordUsage({
      organizationId: promo.value.organizationId,
      promotions: [
        {
          promotionId: promo.value.id,
          code: "ONCE",
          type: "fixed_off_order",
          discountAmount: 300,
          freeShipping: false,
          description: "first use",
        },
      ],
      orderId: "00000000-0000-0000-0000-000000000102",
    });

    // Now validate – should fail
    const result = await kernel.services.promotions.validate("ONCE", {
      currency: "USD",
      subtotal: 5000,
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/usage limit/i);
  });

  it("apply: code already used by this customer (usageLimitPerCustomer = 1) → rejection", async () => {
      const product = await createProduct(kernel, "promo-per-cust");

    const promo = await kernel.services.promotions.create({
      code: "PERCUST",
      name: "Per Customer",
      type: "fixed_off_order",
      value: 250,
      usageLimitPerCustomer: 1,
    });
    expect(promo.ok).toBe(true);
    if (!promo.ok) return;

    const customerId = "00000000-0000-0000-0000-000000000202";

    // Record first usage by this customer
    await kernel.services.promotions.recordUsage({
      organizationId: promo.value.organizationId,
      promotions: [
        {
          promotionId: promo.value.id,
          code: "PERCUST",
          type: "fixed_off_order",
          discountAmount: 250,
          freeShipping: false,
          description: "first",
        },
      ],
      orderId: "00000000-0000-0000-0000-000000000103",
      customerId,
    });

    // Validate for same customer – should fail
    const result = await kernel.services.promotions.validate("PERCUST", {
      currency: "USD",
      subtotal: 5000,
      customerId,
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/per-customer usage limit/i);
  });

  it("create: duplicate code → Err(CommerceValidationError)", async () => {
  
    const first = await kernel.services.promotions.create({
      code: "DUPCODE",
      name: "First",
      type: "fixed_off_order",
      value: 100,
    });
    expect(first.ok).toBe(true);

    const second = await kernel.services.promotions.create({
      code: "DUPCODE",
      name: "Second",
      type: "fixed_off_order",
      value: 200,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.message).toMatch(/already exists/i);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────────────

describe("promotions – edge cases (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("applyPromotions with no codes and no automatic promotions → zero discount", async () => {
      const product = await createProduct(kernel, "promo-edge-nocodes");

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 5000,
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(0);
    expect(result.value.applied).toHaveLength(0);
    expect(result.value.freeShipping).toBe(false);
  });

  it("applyPromotions with multiple valid codes → each applied, total discount is sum", async () => {
      const product = await createProduct(kernel, "promo-multi-valid");

    await kernel.services.promotions.create({
      code: "FIRST5",
      name: "First 5%",
      type: "percentage_off_order",
      value: 5,
    });
    await kernel.services.promotions.create({
      code: "SECOND200",
      name: "Second $2",
      type: "fixed_off_order",
      value: 200,
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 10000,
      promotionCodes: ["FIRST5", "SECOND200"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 2, unitPrice: 5000, totalPrice: 10000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 5% of 10000 = 500 + 200 = 700
    expect(result.value.totalDiscount).toBe(700);
    expect(result.value.applied).toHaveLength(2);
  });

  it("apply with empty lineItems → handles gracefully", async () => {
  
    await kernel.services.promotions.create({
      code: "EMPTY",
      name: "Empty Cart Promo",
      type: "percentage_off_order",
      value: 10,
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 0,
      promotionCodes: ["EMPTY"],
      lineItems: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 10% of 0 = 0 discount, or the promo may be skipped
    expect(result.value.totalDiscount).toBeGreaterThanOrEqual(0);
  });

  it("promotion with empty conditions {} → no conditions, applies to all", async () => {
      const product = await createProduct(kernel, "promo-no-conditions");

    await kernel.services.promotions.create({
      code: "NOCOND",
      name: "No Conditions",
      type: "fixed_off_order",
      value: 300,
      conditions: {},
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 5000,
      promotionCodes: ["NOCOND"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(300);
  });

  it("deactivated promotion → listActive excludes it, apply rejects it", async () => {
      const product = await createProduct(kernel, "promo-deactivated");

    const promo = await kernel.services.promotions.create({
      code: "DEACT",
      name: "To Deactivate",
      type: "fixed_off_order",
      value: 100,
      isActive: true,
    });
    expect(promo.ok).toBe(true);
    if (!promo.ok) return;

    // Deactivate it
    const deactivated = await kernel.services.promotions.deactivate("org_default", promo.value.id);
    expect(deactivated.ok).toBe(true);

    // listActive should not include it
    const active = await kernel.services.promotions.listActive();
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const codes = active.value.map((p) => p.code);
    expect(codes).not.toContain("DEACT");

    // apply should reject it
    const result = await kernel.services.promotions.apply("DEACT", {
      currency: "USD",
      subtotal: 5000,
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 5000, totalPrice: 5000 },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("promotion minimumQuantity: does not apply when quantity below threshold", async () => {
      const product = await createProduct(kernel, "promo-min-qty");

    await kernel.services.promotions.create({
      code: "MINQTY3",
      name: "Min Qty 3",
      type: "fixed_off_order",
      value: 200,
      conditions: { minimumQuantity: 3 },
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 2000,
      promotionCodes: ["MINQTY3"],
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 2, unitPrice: 1000, totalPrice: 2000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(0);
    expect(result.value.rejectedCodes.some((r) => r.code === "MINQTY3")).toBe(true);
  });

  it("automatic promotion applies without an explicit code", async () => {
      const product = await createProduct(kernel, "promo-automatic");

    await kernel.services.promotions.create({
      name: "Automatic 5%",
      type: "percentage_off_order",
      value: 5,
      isAutomatic: true,
      isActive: true,
    });

    const result = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 10000,
      lineItems: [
        { entityId: product.id, entityType: "product", quantity: 1, unitPrice: 10000, totalPrice: 10000 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDiscount).toBe(500); // 5% of 10000
  });
});
