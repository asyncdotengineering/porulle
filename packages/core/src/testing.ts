/**
 * Test utilities for UnifiedCommerce plugins and apps.
 *
 * Import from "@porulle/core/testing" — NOT from "@porulle/core".
 * This sub-path is isolated from the main barrel to avoid pulling drizzle-kit,
 * tsx, esbuild, and other heavy dev-only deps into bundlers like Turbopack.
 */

export { createTestKernel } from "./test-utils/create-test-kernel.js";
// The query log is the only honest statement counter: the PGlite logger sees every statement core
// issues, which a proxy around a plugin's own handle cannot.
export { createPGliteTestAdapter, type PGliteTestAdapter, type QueryLog } from "./test-utils/create-pglite-adapter.js";
export { createTestPluginContext } from "./test-utils/create-test-plugin-context.js";
export { createRepositoryTestHarness } from "./test-utils/create-repository-test-harness.js";
export { createPluginTestApp, type PluginTestApp, type TestAppEnv } from "./test-utils/create-plugin-test-app.js";
export {
  TEST_ORG_ID,
  testAdminActor, testStaffActor, testCustomerActor, testNoPermActor,
  jsonHeaders,
} from "./test-utils/test-actors.js";
export { beforeHook, afterHook } from "./test-utils/typed-hooks.js";
export { markOrderPaidForTest } from "./test-utils/order-test-helpers.js";

// The after-commit boundary predicate, so a suite can assert that the code under test really is
// inside one. A plugin reaches the database through the `ctx.db` HANDLE, not the adapter, and the
// boundary on that path comes from the proxy in `normalizeExecuteShape`; without it an after-hook
// runs INSIDE the open transaction and deadlocks on its own connection. That regression is silent
// — after-hook failures are collected into a HookReport and never thrown — so a suite has to ask
// the question directly rather than wait for a symptom.
export { isInsideTransaction } from "./kernel/hooks/deferred.js";

// A hook that fails is announced to nobody: an after-hook must not fail the write it records, so
// `runAfterHooks` collects failures into a HookReport and the after-commit path cannot even do
// that. The vitest setup file wired in vitest.shared.js turns them into a test failure; this is the
// escape hatch for a suite that causes one deliberately.
export { allowHookFailure, recordedHookFailures } from "./test-utils/hook-failures.js";
export type { HookFailure } from "./kernel/hooks/failures.js";

// Actor type re-export for plugin tests that build custom test actors.
export type { Actor } from "./auth/types.js";
