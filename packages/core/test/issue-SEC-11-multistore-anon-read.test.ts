import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

/**
 * SEC-11 (multi-store) — authenticated catalog reads are scoped to the
 * request's store. The entity service must allow a reader to read their own
 * store's product but not another store's.
 */
const ORG_A = "org_sec11ms_a";
const ORG_B = "org_sec11ms_b";

const admin = (org: string): Actor => ({
  type: "user", userId: `admin_${org}`, email: `a@${org}.test`, name: "admin",
  vendorId: null, organizationId: org, role: "admin", permissions: ["*:*"],
});
const reader = (org: string): Actor => ({
  type: "user", userId: `reader_${org}`, email: `${org}@test.local`, name: "reader",
  vendorId: null, organizationId: org, role: "staff", permissions: ["catalog:read"],
});

describe("SEC-11 — authenticated reads are store-scoped", () => {
  let services: Awaited<ReturnType<typeof createTestKernel>>["services"];
  let entA: string;
  let entB: string;

  beforeAll(async () => {
    const kernel = await createTestKernel();
    services = kernel.services;
    await services.organization.create({ id: ORG_A, name: "Store A", slug: "sec11ms-a" });
    await services.organization.create({ id: ORG_B, name: "Store B", slug: "sec11ms-b" });
    const a = await services.catalog.create({ type: "product", slug: "ms-a", status: "active" }, admin(ORG_A));
    const b = await services.catalog.create({ type: "product", slug: "ms-b", status: "active" }, admin(ORG_B));
    if (!a.ok || !b.ok) throw new Error(`seed failed: ${JSON.stringify([a, b])}`);
    entA = a.value.id;
    entB = b.value.id;
  });

  it("a reader in store B reads store B's product", async () => {
    const r = await services.catalog.getById(entB, undefined, reader(ORG_B));
    expect(r.ok).toBe(true);
  });

  it("a reader in store B cannot read store A's product", async () => {
    const r = await services.catalog.getById(entA, undefined, reader(ORG_B));
    expect(r.ok).toBe(false);
  });
});
