import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders, TEST_ORG_ID };

/** POS admin with pos:admin + pos:manage + pos:operate + cart perms. */
export const posAdminActor: Actor = {
  type: "user",
  userId: "pos-admin-1",
  email: "pos-admin@test.local",
  name: "POS Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: ["pos:admin", "pos:manage", "pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
};

/** POS operator with pos:operate + cart perms. */
export const posOperatorActor: Actor = {
  type: "user",
  userId: "pos-operator-1",
  email: "cashier@test.local",
  name: "Cashier",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: ["pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
};

/** POS manager with pos:manage + pos:operate + cart perms. */
export const posManagerActor: Actor = {
  type: "user",
  userId: "pos-manager-1",
  email: "manager@test.local",
  name: "Manager",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: ["pos:manage", "pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
};
