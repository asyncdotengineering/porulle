/**
 * The customer profile Porulle creates lazily must carry the shopper's email.
 *
 * `getOrCreateByUserId` created the `customers` row on first access (the profile route, checkout)
 * with only the organization and user id. The auth user HAS an email; the profile did not. Every
 * new shopper therefore had an email-less profile, and email is the key channel redaction uses — an
 * account whose orders were later exported could not be erased (2026-09-24).
 *
 * `customers` is unique on (organization, email), and another shopper's profile can already hold
 * the address (a profile email edited to it). Copying it then would fail the whole profile read, so
 * the email is copied only when no other profile in the organization holds it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { user } from "../src/auth/auth-schema.js";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import { customers } from "../src/modules/customers/schema.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

describe("the lazily created customer profile's email", () => {
  let kernel: ReturnType<typeof createKernel>;
  let db: DrizzleDatabase;
  let cleanup: () => Promise<void>;

  const shopper = (id: string): Actor => ({
    type: "user",
    userId: id,
    email: `${id}@shoppers.example`,
    name: id,
    vendorId: null,
    organizationId: DEFAULT_ORG_ID,
    role: "customer",
    permissions: ["customers:read:self", "customers:update:self"],
  });
  const signUp = (id: string) => db.insert(user).values({ id, name: id, email: `${id}@shoppers.example` });
  const profileEmail = async (id: string) =>
    (await db.select({ email: customers.email }).from(customers)
      .where(and(eq(customers.organizationId, DEFAULT_ORG_ID), eq(customers.userId, id))))[0]?.email;

  beforeAll(async () => {
    const pglite = await createPGliteTestAdapter();
    db = pglite.db;
    cleanup = pglite.cleanup;
    kernel = createKernel(await createTestConfig({ databaseAdapter: pglite.adapter }));
  }, 60_000);

  afterAll(async () => { await cleanup(); });

  it("copies the auth user's email onto a profile created on first access", async () => {
    await signUp("new-shopper");

    const profile = await kernel.services.customers.getByUserId("new-shopper", shopper("new-shopper"));

    expect(profile.ok && profile.value.email).toBe("new-shopper@shoppers.example");
    expect(await profileEmail("new-shopper")).toBe("new-shopper@shoppers.example");
  });

  it("fills an existing email-less profile on its next access", async () => {
    await signUp("old-shopper");
    await db.insert(customers).values({ organizationId: DEFAULT_ORG_ID, userId: "old-shopper", metadata: {} });
    expect(await profileEmail("old-shopper")).toBeNull();

    const profile = await kernel.services.customers.getByUserId("old-shopper", shopper("old-shopper"));

    expect(profile.ok && profile.value.email).toBe("old-shopper@shoppers.example");
    expect(await profileEmail("old-shopper")).toBe("old-shopper@shoppers.example");
  });

  it("control: never overwrites a profile's non-null email", async () => {
    await signUp("kept-shopper");
    await db.insert(customers).values({ organizationId: DEFAULT_ORG_ID, userId: "kept-shopper", email: "chosen@elsewhere.example", metadata: {} });

    const profile = await kernel.services.customers.getByUserId("kept-shopper", shopper("kept-shopper"));

    expect(profile.ok && profile.value.email).toBe("chosen@elsewhere.example");
  });

  it("control: when another shopper's profile already holds the email, the profile is still created, without it", async () => {
    await signUp("twin");
    await signUp("holder");
    await db.insert(customers).values({ organizationId: DEFAULT_ORG_ID, userId: "holder", email: "twin@shoppers.example", metadata: {} });

    const profile = await kernel.services.customers.getByUserId("twin", shopper("twin"));

    expect(profile.ok, profile.ok ? "" : profile.error.message).toBe(true);
    expect(profile.ok && profile.value.email).toBeNull();
    const holders = await db.select({ userId: customers.userId }).from(customers)
      .where(and(eq(customers.organizationId, DEFAULT_ORG_ID), eq(customers.email, "twin@shoppers.example")));
    expect(holders).toEqual([{ userId: "holder" }]);
  });
});
