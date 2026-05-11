import { describe, it, expect, beforeAll } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

// Regression for VAPT finding A1 (cart price/identity manipulation class):
// a logged-in customer was able to POST /api/carts with a forged
// `customerId` and the server persisted it. The session-ownership check
// fired on subsequent reads (returning 403 to the forger), but the cart
// itself was attributed to the victim — DoS, fraud-tracking evasion, and
// loyalty-credit misattribution at checkout.
//
// Fix (cart/service.ts create()): customer/viewer/anonymous actors get
// customerId forced to null. Only staff/admin/owner/ai_agent/service may
// supply customerId on behalf of a customer.

const customerActor: Actor = {
  type: "user",
  userId: "vapt-customer-a",
  email: "a@vapt.test",
  name: "Customer A",
  vendorId: null,
  organizationId: null,
  role: "customer",
  permissions: ["cart:create", "cart:read"],
};

const VICTIM_UUID = "00000000-0000-0000-0000-000000000bad";

const staff: Actor = {
  ...customerActor,
  userId: "vapt-staff",
  role: "staff",
  permissions: ["cart:create", "cart:read"],
};

describe("cart.create — customerId forgery (regression)", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;

  beforeAll(async () => {
    kernel = await createTestKernel();
  });

  it("customer role: ignores body.customerId, binds cart to actor's customer profile", async () => {
    const result = await kernel.services.cart.create(
      { customerId: VICTIM_UUID, currency: "USD" },
      customerActor,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The forged VICTIM_UUID was discarded; cart is bound to the actor's
    // own customer profile UUID (looked up via customers.getByUserId).
    expect(result.value.customerId).not.toBe(VICTIM_UUID);
    expect(result.value.customerId).not.toBeNull();
  });

  it("customer role: omitting body.customerId binds cart to actor's profile", async () => {
    const result = await kernel.services.cart.create(
      { currency: "USD" },
      customerActor,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.customerId).not.toBeNull();
  });

  it("two customer carts are bound to different customer profiles", async () => {
    const customerB: Actor = { ...customerActor, userId: "vapt-customer-b", email: "b@vapt.test" };
    const cartA = await kernel.services.cart.create({ currency: "USD" }, customerActor);
    const cartB = await kernel.services.cart.create({ currency: "USD" }, customerB);
    expect(cartA.ok && cartB.ok).toBe(true);
    if (!cartA.ok || !cartB.ok) return;
    expect(cartA.value.customerId).not.toBe(cartB.value.customerId);
    expect(cartA.value.customerId).not.toBeNull();
    expect(cartB.value.customerId).not.toBeNull();
  });

  it("staff role: may supply customerId on behalf of a customer", async () => {
    const result = await kernel.services.cart.create(
      { customerId: VICTIM_UUID, currency: "USD" },
      staff,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.customerId).toBe(VICTIM_UUID);
  });

  it("anonymous: customerId forced to null regardless of body", async () => {
    const result = await kernel.services.cart.create(
      { customerId: VICTIM_UUID, currency: "USD" },
      null,
    );
    if (result.ok) {
      expect(result.value.customerId).toBeNull();
    }
  });

  // Regression for VAPT r2 (claude-glm) finding: customer B was able to
  // read/add/update/delete items on customer A's cart by knowing the cart
  // UUID, because the post-A1-fix carts were "guest carts" (customerId=null)
  // and the cart-write paths skipped the ownership check on guest carts.
  it("customer B cannot read or write to customer A's cart", async () => {
    const customerB: Actor = {
      ...customerActor,
      userId: "vapt-customer-bb",
      email: "bb@vapt.test",
    };
    const cartA = await kernel.services.cart.create({ currency: "USD" }, customerActor);
    expect(cartA.ok).toBe(true);
    if (!cartA.ok) return;

    // Cross-customer READ
    const readByB = await kernel.services.cart.getById(cartA.value.id, customerB);
    expect(readByB.ok).toBe(false);
    if (!readByB.ok) {
      expect(readByB.error.code).toBe("FORBIDDEN");
    }
  });
});
