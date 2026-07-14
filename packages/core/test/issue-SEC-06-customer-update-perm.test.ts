import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

const ORG_ID = "org_default";

const admin: Actor = {
  type: "user",
  userId: "cust-admin",
  email: "admin@cust.test",
  name: "Customer Admin",
  vendorId: null,
  organizationId: ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

const readOnlyActor: Actor = {
  type: "user",
  userId: "cust-reader",
  email: "reader@cust.test",
  name: "Customer Reader",
  vendorId: null,
  organizationId: ORG_ID,
  role: "staff",
  permissions: ["customers:read"],
};

const updateActor: Actor = {
  type: "user",
  userId: "cust-updater",
  email: "updater@cust.test",
  name: "Customer Updater",
  vendorId: null,
  organizationId: ORG_ID,
  role: "staff",
  permissions: ["customers:update"],
};

describe("SEC-06 — CustomerService.update requires customers:update", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let customerId: string;

  beforeAll(async () => {
    kernel = await createTestKernel();

    const created = await kernel.services.customers.createWalkIn(
      { email: "victim@example.com", firstName: "Victim" },
      admin,
    );
    if (!created.ok) {
      throw new Error(`Failed to seed customer: ${JSON.stringify(created.error)}`);
    }
    customerId = created.value.id;
  });

  it("rejects customers:read-only actor with FORBIDDEN", async () => {
    const result = await kernel.services.customers.update(
      customerId,
      { email: "hijacked@evil.test" },
      readOnlyActor,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("allows customers:update actor to update", async () => {
    const result = await kernel.services.customers.update(
      customerId,
      { email: "updated@example.com" },
      updateActor,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email).toBe("updated@example.com");
    }
  });
});