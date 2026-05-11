import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders, TEST_ORG_ID };
export const loyaltyAdminActor: Actor = {
  type: "user", userId: "loyalty-admin", email: "loyalty@test.local", name: "Loyalty Admin",
  vendorId: null, organizationId: TEST_ORG_ID, role: "staff",
  permissions: ["loyalty:admin", "catalog:read"],
};
