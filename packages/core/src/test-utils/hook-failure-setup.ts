import { afterEach, beforeEach } from "vitest";
import {
  armHookFailureCollector,
  resetHookFailures,
  unallowedHookFailureMessage,
} from "./hook-failures.js";

/**
 * A vitest setup file, wired once in `vitest.shared.js` so every package in the monorepo inherits
 * it. It is a setup file rather than something `createPluginTestApp` installs because the check has
 * to be a default nobody remembers to ask for: the case it exists to catch is precisely a suite
 * nobody thought to instrument.
 *
 * Measured 2026-09-15 on the connector suites with the after-commit boundary removed from the
 * plugin db path: 578.23 s instead of 27.29 s, 51 `Hook "deliverWebhooks" timed out after 20000ms`,
 * and exit 0 with every test passing. After-hook failures are collected into a `HookReport` and
 * never thrown, so the run was green; nothing in the monorepo asked whether the report was clean.
 */
armHookFailureCollector();

beforeEach(() => {
  resetHookFailures();
});

afterEach(() => {
  const message = unallowedHookFailureMessage();
  resetHookFailures();
  if (message) throw new Error(message);
});
