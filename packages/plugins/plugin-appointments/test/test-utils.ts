import { createTestActor, TEST_ORG_ID } from "@porulle/core/testing";
/**
 * Re-exports from @porulle/core for appointment plugin tests.
 *
 * Plugin-specific actors (with appointments:manage, appointments:book scopes)
 * are defined here. Generic actors and helpers come from core.
 */


/** Staff actor with appointments:manage permission. */
export const managerActor = createTestActor({
  userId: "manager-1",
  email: "manager@test.local",
  name: "Manager",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: ["appointments:manage"],
});

/** Customer actor with appointments:book permission. */
export const customerActor = createTestActor({
  userId: "customer-1",
  email: "customer@test.local",
  name: "Customer",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "customer",
  permissions: ["appointments:book"],
});
