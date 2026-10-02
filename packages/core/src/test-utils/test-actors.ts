import type { Actor } from "../auth/types.js";
import { DEFAULT_ORG_ID } from "../auth/org.js";

/**
 * Organization ID used in test fixtures. Tests use the deprecated DEFAULT_ORG_ID
 * because ensureDefaultOrg() creates this org during test setup. When
 * DEFAULT_ORG_ID is removed, test setup will create a real org via the
 * Better Auth API instead.
 */
export const TEST_ORG_ID = DEFAULT_ORG_ID;

/**
 * A test actor in {@link TEST_ORG_ID}. Pass only what the test is about —
 * usually `permissions` (and `role`); everything else has a stable default.
 */
export function createTestActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "user",
    userId: "test-user-1",
    email: "user@test.local",
    name: "Test User",
    vendorId: null,
    organizationId: TEST_ORG_ID,
    role: "staff",
    permissions: [],
    ...overrides,
  };
}

/** Staff with the permissions the REST suites exercise. */
export const testActor: Actor = createTestActor({
  userId: "00000000-0000-0000-0000-000000000001",
  email: "test@example.com",
  name: "Test Staff",
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "catalog:read:unpublished",
    "inventory:adjust",
    "inventory:read",
    "orders:create",
    "orders:create:on-behalf",
    "orders:read",
    "orders:update",
    "orders:manage",
    "cart:create",
    "cart:update",
    "cart:read",
    "cart:manage",
    "customers:update:self",
    "webhooks:manage",
    "pricing:manage",
    "shipping:manage",
    "tax:manage",
    "settings:manage",
    "analytics:read",
    "staff:manage",
    "promotions:manage",
    "promotions:read",
    "audit:read",
    "media:write",
    "compensation:admin",
  ],
});

/** Read-only shopper: browses and reads its own orders, cannot create a cart. */
export const readonlyActor: Actor = createTestActor({
  userId: "00000000-0000-0000-0000-000000000002",
  email: "readonly@example.com",
  name: "Read Only User",
  role: "customer",
  permissions: ["catalog:read", "cart:read", "orders:read:own"],

});

/** Admin with wildcard permissions. Use for setup operations in beforeAll. */
export const testAdminActor: Actor = {
  type: "user",
  userId: "test-admin-1",
  email: "admin@test.local",
  name: "Test Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

/** Staff with common operational permissions. */
export const testStaffActor: Actor = {
  type: "user",
  userId: "test-staff-1",
  email: "staff@test.local",
  name: "Test Staff",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: [
    "catalog:read", "catalog:read:unpublished", "catalog:create", "catalog:update",
    "inventory:adjust", "orders:read", "orders:create", "orders:create:on-behalf", "orders:update", "orders:manage",
  ],
};

/** Customer with minimal read/write-own permissions. */
export const testCustomerActor: Actor = {
  type: "user",
  userId: "test-customer-1",
  email: "customer@test.local",
  name: "Test Customer",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "customer",
  permissions: ["catalog:read", "cart:create", "cart:read", "orders:read:own"],
};

/** Actor with zero permissions. Use for negative auth/perm tests. */
export const testNoPermActor: Actor = {
  type: "user",
  userId: "test-noperm-1",
  email: "noperm@test.local",
  name: "No Permissions",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "customer",
  permissions: [],
};

/**
 * Builds request headers with optional test actor injection.
 * The x-test-actor header is parsed by createPluginTestApp's middleware.
 */
export function jsonHeaders(actor?: Actor): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) headers["x-test-actor"] = JSON.stringify(actor);
  return headers;
}
