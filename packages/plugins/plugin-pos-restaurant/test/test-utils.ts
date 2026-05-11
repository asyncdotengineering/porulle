import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders, TEST_ORG_ID };

/** Restaurant admin with pos-restaurant:admin + pos:operate + pos:manage. */
export const restaurantAdminActor: Actor = {
  type: "user",
  userId: "restaurant-admin-1",
  email: "restaurant-admin@test.local",
  name: "Restaurant Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: ["pos-restaurant:admin", "pos:admin", "pos:manage", "pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
};

/** POS operator (server/cashier). */
export const serverActor: Actor = {
  type: "user",
  userId: "server-1",
  email: "server@test.local",
  name: "Server",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: ["pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
};
