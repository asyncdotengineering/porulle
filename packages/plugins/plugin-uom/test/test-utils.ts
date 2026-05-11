import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID };
import type { Actor  } from "@porulle/core/testing";
export const uomAdminActor: Actor = {
  type: "user", userId: "uom-admin-1", email: "uom@test.local",
  name: "UOM Admin", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["uom:admin", "uom:read"],
};
export const uomReaderActor: Actor = {
  type: "user", userId: "uom-reader-1", email: "reader@test.local",
  name: "Reader", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["uom:read"],
};
