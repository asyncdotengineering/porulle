/**
 * Guard: Porulle's Drizzle auth schema must declare every column better-auth
 * writes. Derived from getAuthTables() — not a hand-maintained field list.
 */

import { describe, it, expect } from "vitest";
import {
  assertAuthSchemaParity,
  findAuthSchemaParityMismatches,
} from "../src/auth/auth-schema-guard.js";

describe("auth schema parity with installed better-auth", () => {
  it("declares every core auth table column better-auth expects", () => {
    const mismatches = findAuthSchemaParityMismatches();
    expect(mismatches).toEqual([]);
    assertAuthSchemaParity();
  });
});
