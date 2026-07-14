import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

/**
 * SEC-10 — user-facing callers of `findEntityById` must pass the actor's org so
 * another tenant's entity id cannot be operated on. Proven representative case:
 * `pricing.setBasePrice` previously fetched the entity unscoped and stamped a
 * price row for org-A referencing org-B's entity. (cart.addItem and
 * pricing.resolve share the same one-line scoped-lookup fix.)
 */
const ORG_A = "org_sec10_a";
const ORG_B = "org_sec10_b";
const admin = (org: string): Actor => ({
  type: "user", userId: `admin_${org}`, email: `a@${org}.test`, name: "admin",
  vendorId: null, organizationId: org, role: "admin", permissions: ["*:*"],
});

describe("SEC-10 — cross-org entity lookups are org-scoped", () => {
  let services: Awaited<ReturnType<typeof createTestKernel>>["services"];
  let entB: string;

  beforeAll(async () => {
    const kernel = await createTestKernel();
    services = kernel.services;
    await services.organization.create({ id: ORG_A, name: "A", slug: "sec10-a" });
    await services.organization.create({ id: ORG_B, name: "B", slug: "sec10-b" });
    const b = await services.catalog.create({ type: "product", slug: "sec10-b" }, admin(ORG_B));
    if (!b.ok) throw new Error(`seed failed: ${JSON.stringify(b)}`);
    entB = b.value.id;
  });

  it("setBasePrice rejects an entity owned by another org", async () => {
    const res = await services.pricing.setBasePrice(
      { entityId: entB, currency: "USD", amount: 500 },
      admin(ORG_A),
    );
    expect(res.ok).toBe(false);
  });

  it("setBasePrice allows the owning org (control)", async () => {
    const res = await services.pricing.setBasePrice(
      { entityId: entB, currency: "USD", amount: 500 },
      admin(ORG_B),
    );
    expect(res.ok).toBe(true);
  });
});
