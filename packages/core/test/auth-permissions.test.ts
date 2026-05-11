import { describe, expect, it } from "vitest";
import { assertOwnership, assertPermission } from "../src/auth/permissions.js";
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
  });
});
