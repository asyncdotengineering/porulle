import { TEST_ORG_ID } from "@porulle/core/testing";
import type { Actor } from "@porulle/core";

export const notifAdminActor: Actor = {
  type: "user", userId: "notif-admin-1", email: "notif@test.local",
  name: "Notif Admin", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["notifications:admin", "notifications:write", "notifications:read"],
};

export const notifWriterActor: Actor = {
  type: "user", userId: "notif-writer-1", email: "writer@test.local",
  name: "Writer", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["notifications:write", "notifications:read"],
};

export const notifReaderActor: Actor = {
  type: "user", userId: "notif-reader-1", email: "reader@test.local",
  name: "Reader", vendorId: null, organizationId: TEST_ORG_ID,
  role: "staff", permissions: ["notifications:read"],
};
