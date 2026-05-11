import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID };
import type { Actor  } from "@porulle/core/testing";
export const procAdminActor: Actor = {
  type: "user", userId: "proc-admin", email: "proc@test.local", name: "Procurement Admin",
  vendorId: null, organizationId: TEST_ORG_ID, role: "staff",
  permissions: ["procurement:admin", "procurement:create", "procurement:read"],
};
export const procStaffActor: Actor = {
  type: "user", userId: "proc-staff", email: "staff@test.local", name: "Staff",
  vendorId: null, organizationId: TEST_ORG_ID, role: "staff",
  permissions: ["procurement:create", "procurement:read"],
};
