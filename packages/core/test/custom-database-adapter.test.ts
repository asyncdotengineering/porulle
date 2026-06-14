/**
 * Custom DatabaseAdapter injection (#10)
 *
 * defineConfig accepts ANY DatabaseAdapter implementation — not just
 * @porulle/adapter-postgres (postgres-js). kernel.database.db is the generic
 * adapter type (not pinned to a specific driver), so an edge driver such as
 * neon-http can be injected. Proven here with the PGlite adapter, which is a
 * non-postgres-js driver and the one the whole test suite already runs on.
 */

import { describe, it, expect } from "vitest";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { createKernel } from "../src/runtime/kernel.js";
import { unwrapDb } from "../src/kernel/database/adapter.js";
import type { DatabaseAdapter } from "../src/index.js";

describe("custom DatabaseAdapter injection (#10)", () => {
  it("defineConfig accepts a non-postgres-js DatabaseAdapter and the kernel uses it", async () => {
    // PGlite — a driver that is NOT postgres-js — implementing the contract.
    const { adapter } = await createPGliteTestAdapter();
    const custom: DatabaseAdapter = adapter;

    const config = await createTestConfig({ databaseAdapter: custom });
    expect(config.databaseAdapter).toBe(custom);

    const kernel = createKernel(config);
    expect(kernel.database.provider).toBe(custom.provider);
    // The injected driver flows through to the kernel (unwrapping the
    // execute-normalization proxy added in #11).
    expect(unwrapDb(kernel.database.db)).toBe(custom.db);
  });
});
