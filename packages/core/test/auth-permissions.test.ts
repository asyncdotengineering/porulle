import { describe, expect, it } from "vitest";
import { assertOwnership, assertPermission, requireUserId } from "../src/auth/permissions.js";
import { CommerceForbiddenError } from "../src/kernel/errors.js";

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
  });

  it("rejects missing permission", () => {
    expect(() => assertPermission(actor, "inventory:adjust")).toThrow(CommerceForbiddenError);
  });

  it("enforces ownership", () => {
    expect(() => assertOwnership(actor, "u1")).not.toThrow();
    expect(() => assertOwnership(actor, "u2")).toThrow(CommerceForbiddenError);
    expect(() => assertOwnership({ ...actor, userId: null }, null)).toThrow(CommerceForbiddenError);
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
