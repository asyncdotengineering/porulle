import { createTestActor } from "@porulle/core/testing";

export const notifAdminActor = createTestActor({
  userId: "notif-admin-1",
  email: "notif@test.local",
  name: "Notif Admin",
  permissions: ["notifications:admin", "notifications:write", "notifications:read"],
});

export const notifWriterActor = createTestActor({
  userId: "notif-writer-1",
  email: "writer@test.local",
  name: "Writer",
  permissions: ["notifications:write", "notifications:read"],
});

export const notifReaderActor = createTestActor({
  userId: "notif-reader-1",
  email: "reader@test.local",
  name: "Reader",
  permissions: ["notifications:read"],
});
