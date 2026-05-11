import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID };
import type { Actor  } from "@porulle/core/testing";
export const whAdminActor: Actor = {
  type: "user", userId: "wh-admin", email: "wh@test.local", name: "WH Admin",
  vendorId: null, organizationId: TEST_ORG_ID, role: "staff",
  permissions: ["warehouse:admin", "warehouse:operate", "warehouse:read"],
};
export const whStaffActor: Actor = {
  type: "user", userId: "wh-staff", email: "staff@test.local", name: "Staff",
  vendorId: null, organizationId: TEST_ORG_ID, role: "staff",
  permissions: ["warehouse:operate", "warehouse:read"],
};
