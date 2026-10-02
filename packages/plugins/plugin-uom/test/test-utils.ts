import { createTestActor, TEST_ORG_ID } from "@porulle/core/testing";
import type { Actor  } from "@porulle/core/testing";
export const uomAdminActor = createTestActor({
  type: "user", userId: "uom-admin-1", email: "uom@test.local",
  name: "UOM Admin", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["uom:admin", "uom:read"],
});
export const uomReaderActor = createTestActor({
  type: "user", userId: "uom-reader-1", email: "reader@test.local",
  name: "Reader", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["uom:read"],
});
