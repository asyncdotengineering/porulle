/**
 * Re-exports from @porulle/core for gift card plugin tests.
 */
import {
  createPluginTestApp,
  testAdminActor,
  testCustomerActor,
  testNoPermActor,
  jsonHeaders,
  TEST_ORG_ID,
} from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testCustomerActor, testNoPermActor, jsonHeaders, TEST_ORG_ID };

/** Admin with gift-cards:admin permission. */
export const giftCardAdminActor: Actor = {
  type: "user",
  userId: "gc-admin-1",
  email: "gc-admin@test.local",
  name: "GC Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: ["gift-cards:admin"],
};

/** Customer actor. */
export const customerActor: Actor = {
  type: "user",
  userId: "gc-customer-1",
  email: "customer@test.local",
  name: "Customer",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "customer",
  permissions: [],
};
