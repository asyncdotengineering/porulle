/**
 * Re-exports from @porulle/core for appointment plugin tests.
 *
 * Plugin-specific actors (with appointments:manage, appointments:book scopes)
 * are defined here. Generic actors and helpers come from core.
 */

export {
  createPluginTestApp,
  testAdminActor,
  testNoPermActor,
  jsonHeaders,
} from "@porulle/core/testing";
import type { Actor } from "@porulle/core/testing";

/** Staff actor with appointments:manage permission. */
export const managerActor: Actor = {
  type: "user",
  userId: "manager-1",
  email: "manager@test.local",
  name: "Manager",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: ["appointments:manage"],
};

/** Customer actor with appointments:book permission. */
export const customerActor: Actor = {
  type: "user",
  userId: "customer-1",
  email: "customer@test.local",
  name: "Customer",
  vendorId: null,
  organizationId: null,
  role: "customer",
  permissions: ["appointments:book"],
};
