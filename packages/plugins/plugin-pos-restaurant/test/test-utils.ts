import { createTestActor, TEST_ORG_ID } from "@porulle/core/testing";
/** Restaurant admin with pos-restaurant:admin + pos:operate + pos:manage. */
export const restaurantAdminActor = createTestActor({
  userId: "restaurant-admin-1",
  email: "restaurant-admin@test.local",
  name: "Restaurant Admin",
  vendorId: null,
  role: "staff",
  permissions: ["pos-restaurant:admin", "pos:admin", "pos:manage", "pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
});

/** POS operator (server/cashier). */
export const serverActor = createTestActor({
  userId: "server-1",
  email: "server@test.local",
  name: "Server",
  vendorId: null,
  role: "staff",
  permissions: ["pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
});
