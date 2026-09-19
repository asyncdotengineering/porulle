import { describe, expect, it } from "vitest";
import { assertOwnership, assertPermission, requireUserId } from "../src/auth/permissions.js";
import { defaultConfig } from "../src/config/defaults.js";
import { CommerceForbiddenError, CommerceUnauthorizedError } from "../src/kernel/errors.js";

describe("permissions", () => {
  const actor = {
    type: "user",
    userId: "u1",
    email: "u1@example.com",
    name: "User 1",
    vendorId: null,
    organizationId: null,
    role: "staff",
    permissions: ["catalog:*", "orders:read:own"],
  } as any;

  it("permits wildcard resource permissions", () => {
    expect(() => assertPermission(actor, "catalog:create")).not.toThrow();
    expect(() => assertPermission(actor, "catalog:read:unpublished")).not.toThrow();
  });

  it("grants the new scopes to the default manager role only", () => {
    const managerPermissions = defaultConfig.auth?.roles?.manager?.permissions ?? [];
    const customerPermissions = defaultConfig.auth?.roles?.customer?.permissions ?? [];

    expect(managerPermissions).toEqual(
      expect.arrayContaining(["catalog:read:unpublished", "orders:create:on-behalf"]),
    );
    expect(customerPermissions).not.toContain("catalog:read:unpublished");
    expect(customerPermissions).not.toContain("orders:create:on-behalf");
  });

  it("rejects missing permission", () => {
    expect(() => assertPermission(actor, "inventory:adjust")).toThrow(CommerceForbiddenError);
  });

  // Both directions in one case, deliberately. A blanket swap of every refusal to 401 would
  // satisfy the anonymous row on its own; only the signed-in non-owner beside it can tell a
  // decision about identity from one about ownership.
  it("enforces ownership", () => {
    expect(() => assertOwnership(actor, "u1")).not.toThrow();

    // A signed-in caller who is simply not the owner. 403 holds whatever credential accompanies
    // the request, which is what RFC 9110 reserves it for.
    expect(() => assertOwnership(actor, "u2")).toThrow(CommerceForbiddenError);

    // No credential at all, in the two shapes that carry one: a null actor, and the user actor
    // with no user id that `storeResolver` mints for an anonymous request. Signing in resolves
    // both, so neither refusal holds against every credential and neither is a 403.
    expect(() => assertOwnership(null, "u1")).toThrow(CommerceUnauthorizedError);
    expect(() => assertOwnership({ ...actor, userId: null }, null)).toThrow(CommerceUnauthorizedError);
  });

  // An identity that is a placeholder rather than a person -- null, or the
  // empty string an API key with no operator and no reference used to carry --
  // must never satisfy ownership, or every such caller owns every such row.
  it("treats a blank identity as no identity", () => {
    expect(() => assertOwnership({ ...actor, userId: "" }, "")).toThrow(CommerceForbiddenError);
    expect(() => assertOwnership({ ...actor, userId: "" }, "u1")).toThrow(CommerceForbiddenError);
  });

  it("refuses to hand out a blank identity as an owner key", () => {
    expect(requireUserId(actor)).toBe("u1");
    expect(() => requireUserId(null)).toThrow(CommerceForbiddenError);
    expect(() => requireUserId({ userId: null })).toThrow(CommerceForbiddenError);
    expect(() => requireUserId({ userId: "" })).toThrow(CommerceForbiddenError);
  });
});
