import { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID } from "@porulle/core/testing";
export { createPluginTestApp, testAdminActor, testNoPermActor, jsonHeaders , TEST_ORG_ID };
import type { Actor  } from "@porulle/core/testing";

export const reviewsAdminActor: Actor = {
  type: "user", userId: "reviews-admin-1", email: "reviews-admin@test.local",
  name: "Reviews Admin", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["reviews:admin", "reviews:write", "reviews:read"],
};

export const reviewsWriterActor: Actor = {
  type: "user", userId: "reviews-writer-1", email: "writer@test.local",
  name: "Writer", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["reviews:write", "reviews:read"],
};

export const reviewsReaderActor: Actor = {
  type: "user", userId: "reviews-reader-1", email: "reader@test.local",
  name: "Reader", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["reviews:read"],
};

export const reviewsCustomerActor: Actor = {
  type: "user", userId: "reviews-customer-1", email: "customer@test.local",
  name: "Customer", vendorId: null, organizationId: TEST_ORG_ID,
  role: "customer", permissions: ["reviews:write", "reviews:read"],
};
