import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

/**
 * SEC-11 (multi-store) — anonymous storefront reads are scoped to the request's
 * store. The auth middleware resolves the org for anonymous requests via
 * `config.auth.storeResolver` and sets a minimal anonymous actor carrying that
 * org; `getById` → `assertSameOrg` must therefore let a visitor read their own
 * store's product but not another store's. This locks the store-awareness the
 * grok Slice-2 fix relies on (kimi WBS R-03).
 */
const ORG_A = "org_sec11ms_a";
const ORG_B = "org_sec11ms_b";

const admin = (org: string): Actor => ({
  type: "user", userId: `admin_${org}`, email: `a@${org}.test`, name: "admin",
  vendorId: null, organizationId: org, role: "admin", permissions: ["*:*"],
});
// The org-bearing anonymous actor that storeResolver middleware sets.
const anon = (org: string): Actor => ({
  type: "user", userId: "anonymous", email: null, name: "anon",
  vendorId: null, organizationId: org, role: "customer", permissions: [],
});

describe("SEC-11 — anonymous reads are store-scoped (storeResolver path)", () => {
  let services: Awaited<ReturnType<typeof createTestKernel>>["services"];
  let entA: string;
  let entB: string;

  beforeAll(async () => {
    const kernel = await createTestKernel();
    services = kernel.services;
    await services.organization.create({ id: ORG_A, name: "Store A", slug: "sec11ms-a" });
    await services.organization.create({ id: ORG_B, name: "Store B", slug: "sec11ms-b" });
    const a = await services.catalog.create({ type: "product", slug: "ms-a" }, admin(ORG_A));
    const b = await services.catalog.create({ type: "product", slug: "ms-b" }, admin(ORG_B));
    if (!a.ok || !b.ok) throw new Error(`seed failed: ${JSON.stringify([a, b])}`);
    entA = a.value.id;
    entB = b.value.id;
  });

  it("anonymous visitor to store B reads store B's product", async () => {
    const r = await services.catalog.getById(entB, undefined, anon(ORG_B));
    expect(r.ok).toBe(true);
  });

  it("anonymous visitor to store B CANNOT read store A's product", async () => {
    const r = await services.catalog.getById(entA, undefined, anon(ORG_B));
    expect(r.ok).toBe(false);
  });
});
