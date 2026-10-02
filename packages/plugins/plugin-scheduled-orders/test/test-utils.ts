import { createTestActor, TEST_ORG_ID } from "@porulle/core/testing";
import type { Actor  } from "@porulle/core/testing";

export const scheduledOrdersAdminActor = createTestActor({
  type: "user", userId: "so-admin-1", email: "so-admin@test.local",
  name: "SO Admin", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["scheduled-orders:admin", "scheduled-orders:create", "scheduled-orders:read"],
});

export const scheduledOrdersCreatorActor = createTestActor({
  type: "user", userId: "so-creator-1", email: "so-creator@test.local",
  name: "SO Creator", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["scheduled-orders:create", "scheduled-orders:read"],
});

export const scheduledOrdersReaderActor = createTestActor({
  type: "user", userId: "so-reader-1", email: "so-reader@test.local",
  name: "SO Reader", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["scheduled-orders:read"],
});
