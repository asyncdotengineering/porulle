/**
 * Test utilities for UnifiedCommerce plugins and apps.
 *
 * Import from "@porulle/core/testing" — NOT from "@porulle/core".
 * This sub-path is isolated from the main barrel to avoid pulling drizzle-kit,
 * tsx, esbuild, and other heavy dev-only deps into bundlers like Turbopack.
 */

export { createTestKernel } from "./test-utils/create-test-kernel.js";
export { createTestPluginContext } from "./test-utils/create-test-plugin-context.js";
export { createRepositoryTestHarness } from "./test-utils/create-repository-test-harness.js";
export { createPluginTestApp, type PluginTestApp, type TestAppEnv } from "./test-utils/create-plugin-test-app.js";
export {
  TEST_ORG_ID,
  testAdminActor, testStaffActor, testCustomerActor, testNoPermActor,
  jsonHeaders,
} from "./test-utils/test-actors.js";
export { beforeHook, afterHook } from "./test-utils/typed-hooks.js";

// Actor type re-export for plugin tests that build custom test actors.
export type { Actor } from "./auth/types.js";
