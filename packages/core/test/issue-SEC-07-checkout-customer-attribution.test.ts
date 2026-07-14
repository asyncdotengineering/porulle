import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";
import { resolveCheckoutCustomerUuid } from "../src/interfaces/rest/routes/checkout.js";

/**
 * SEC-07 — checkout must not let a self-service customer attribute an order to
 * another customer. The resolver returns the actor's OWN profile for a customer
 * even when a foreign customerId is supplied; only staff (org-level
 * customers:read) may name an arbitrary customer.
 */
const ORG = "org_default";
const customer = (userId: string): Actor => ({
  type: "user", userId, email: `${userId}@x.test`, name: userId,
  vendorId: null, organizationId: ORG, role: "customer",
  permissions: ["orders:create", "customers:read:self"],
});
const staff: Actor = {
  type: "user", userId: "staff", email: "s@x.test", name: "staff",
  vendorId: null, organizationId: ORG, role: "admin", permissions: ["*:*"],
};

describe("SEC-07 — checkout customer attribution", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let custA: string;
  let custB: string;

  beforeAll(async () => {
    kernel = await createTestKernel();
    const a = await kernel.services.customers.createWalkIn({ userId: "userA", email: "a@x.test" }, staff);
    const b = await kernel.services.customers.createWalkIn({ userId: "userB", email: "b@x.test" }, staff);
    if (!a.ok || !b.ok) throw new Error("seed failed");
    custA = a.value.id;
    custB = b.value.id;
  });

  it("a customer CANNOT attribute an order to another customer's profile", async () => {
    const resolved = await resolveCheckoutCustomerUuid(kernel.services.customers, customer("userA"), custB);
    expect(resolved).toBe(custA); // falls back to the actor's own profile
    expect(resolved).not.toBe(custB);
  });

  it("a customer's own profile id is honored", async () => {
    const resolved = await resolveCheckoutCustomerUuid(kernel.services.customers, customer("userA"), custA);
    expect(resolved).toBe(custA);
  });

  it("staff MAY attribute to another customer (assisted checkout)", async () => {
    const resolved = await resolveCheckoutCustomerUuid(kernel.services.customers, staff, custB);
    expect(resolved).toBe(custB);
  });
});
