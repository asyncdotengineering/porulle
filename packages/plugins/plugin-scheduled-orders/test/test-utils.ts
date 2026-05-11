import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID };
import type { Actor  } from "@porulle/core/testing";

export const scheduledOrdersAdminActor: Actor = {
  type: "user", userId: "so-admin-1", email: "so-admin@test.local",
  name: "SO Admin", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["scheduled-orders:admin", "scheduled-orders:create", "scheduled-orders:read"],
};

export const scheduledOrdersCreatorActor: Actor = {
  type: "user", userId: "so-creator-1", email: "so-creator@test.local",
  name: "SO Creator", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["scheduled-orders:create", "scheduled-orders:read"],
};

export const scheduledOrdersReaderActor: Actor = {
  type: "user", userId: "so-reader-1", email: "so-reader@test.local",
  name: "SO Reader", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["scheduled-orders:read"],
};
