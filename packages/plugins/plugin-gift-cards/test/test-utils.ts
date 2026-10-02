import { createTestActor } from "@porulle/core/testing";

/** Admin with gift-cards:admin permission. */
export const giftCardAdminActor = createTestActor({
  userId: "gc-admin-1",
  email: "gc-admin@test.local",
  name: "GC Admin",
  vendorId: null,
  role: "staff",
  permissions: ["gift-cards:admin"],
});

/** Customer actor. */
export const customerActor = createTestActor({
  userId: "gc-customer-1",
  email: "customer@test.local",
  name: "Customer",
  vendorId: null,
  role: "customer",
  permissions: [],
});
