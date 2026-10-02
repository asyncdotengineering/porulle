import { createTestActor, TEST_ORG_ID } from "@porulle/core/testing";
/** POS admin with pos:admin + pos:manage + pos:operate + cart perms. */
export const posAdminActor = createTestActor({
  userId: "pos-admin-1",
  email: "pos-admin@test.local",
  name: "POS Admin",
  vendorId: null,
  role: "staff",
  permissions: ["pos:admin", "pos:manage", "pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
});

/** POS operator with pos:operate + cart perms. */
export const posOperatorActor = createTestActor({
  userId: "pos-operator-1",
  email: "cashier@test.local",
  name: "Cashier",
  vendorId: null,
  role: "staff",
  permissions: ["pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
});

/** POS manager with pos:manage + pos:operate + cart perms. */
export const posManagerActor = createTestActor({
  userId: "pos-manager-1",
  email: "manager@test.local",
  name: "Manager",
  vendorId: null,
  role: "staff",
  permissions: ["pos:manage", "pos:operate", "cart:create", "cart:update", "cart:read", "catalog:read"],
});
