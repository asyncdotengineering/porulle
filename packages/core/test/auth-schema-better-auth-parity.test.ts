/**
 * Guard: Porulle's Drizzle auth schema must declare every column better-auth
 * writes. Derived from getAuthTables() — not a hand-maintained field list.
 */

import { describe, it, expect } from "vitest";
import {
  assertAuthSchemaParity,
  findAuthSchemaParityMismatches,
} from "../src/auth/auth-schema-guard.js";
import { createServer } from "../src/runtime/server.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

describe("auth schema parity with installed better-auth", () => {
  it("declares every core auth table column better-auth expects", () => {
    const mismatches = findAuthSchemaParityMismatches();
    expect(mismatches).toEqual([]);
    assertAuthSchemaParity();
  });

  it("constructs the production route table with coverage enforced", async () => {
    const { config, cleanup } = await createPGliteTestConfig({ exposeOpenApiSpec: false });
    try {
      await createServer(config);
    } finally {
      await cleanup();
    }
  });
});
