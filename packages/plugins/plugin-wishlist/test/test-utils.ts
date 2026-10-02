import { createTestActor, TEST_ORG_ID } from "@porulle/core/testing";
import type { Actor  } from "@porulle/core/testing";
export const wishlistUserActor = createTestActor({
  type: "user", userId: "wishlist-user-1", email: "user@test.local", name: "User",
  vendorId: null, organizationId: TEST_ORG_ID, role: "customer",
  permissions: ["wishlist:read", "wishlist:write", "catalog:read"],
});
export const wishlistAdminActor = createTestActor({
  type: "user", userId: "wishlist-admin", email: "admin@test.local", name: "Admin",
  vendorId: null, organizationId: TEST_ORG_ID, role: "staff",
  permissions: ["wishlist:admin", "wishlist:read", "wishlist:write"],
});
