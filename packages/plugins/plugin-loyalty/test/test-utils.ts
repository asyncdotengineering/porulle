import { createTestActor, TEST_ORG_ID } from "@porulle/core/testing";
export const loyaltyAdminActor = createTestActor({
  type: "user", userId: "loyalty-admin", email: "loyalty@test.local", name: "Loyalty Admin",
  vendorId: null, organizationId: TEST_ORG_ID, role: "staff",
  permissions: ["loyalty:admin", "catalog:read"],
});
