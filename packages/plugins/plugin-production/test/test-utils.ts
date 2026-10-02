import { createTestActor, TEST_ORG_ID } from "@porulle/core/testing";
import type { Actor  } from "@porulle/core/testing";

export const productionAdminActor = createTestActor({
  type: "user", userId: "prod-admin-1", email: "prod-admin@test.local",
  name: "Production Admin", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["production:admin", "production:create", "production:read"],
});

export const productionCreatorActor = createTestActor({
  type: "user", userId: "prod-creator-1", email: "prod-creator@test.local",
  name: "Production Creator", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["production:create", "production:read"],
});

export const productionReaderActor = createTestActor({
  type: "user", userId: "prod-reader-1", email: "prod-reader@test.local",
  name: "Production Reader", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["production:read"],
});
