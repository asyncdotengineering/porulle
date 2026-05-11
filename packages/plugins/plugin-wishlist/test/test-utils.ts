import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID };
import type { Actor  } from "@porulle/core/testing";
export const wishlistUserActor: Actor = {
  type: "user", userId: "wishlist-user-1", email: "user@test.local", name: "User",
  vendorId: null, organizationId: TEST_ORG_ID, role: "customer",
  permissions: ["wishlist:read", "wishlist:write", "catalog:read"],
};
export const wishlistAdminActor: Actor = {
  type: "user", userId: "wishlist-admin", email: "admin@test.local", name: "Admin",
  vendorId: null, organizationId: TEST_ORG_ID, role: "staff",
  permissions: ["wishlist:admin", "wishlist:read", "wishlist:write"],
};
