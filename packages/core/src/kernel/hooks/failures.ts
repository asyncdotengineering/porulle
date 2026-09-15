import type { HookError } from "./executor.js";

/**
 * Where after-hook failures go when nobody is listening.
 *
 * An after-hook must never fail the write it is announcing, so `runAfterHooks` collects failures
 * into a `HookReport` and the after-COMMIT path cannot even do that — by the time a deferred hook
 * runs, the service method has already returned its Result. The consequence measured on 2026-09-15:
 * removing the after-commit boundary from the plugin db path made four connector suites take
 * 578.23 s instead of 27.29 s and log 51 `Hook "deliverWebhooks" timed out after 20000ms`, with
 * exit 0 and 22 of 22 tests passing. The only thing that disagreed was the wall clock.
 *
 * So failures are reported here as well as logged. Production installs no observer and pays one
 * undefined check; a test harness installs one and can fail the test that caused it.
 */
export interface HookFailure extends HookError {
  /** True when the hook had been deferred to after the commit, so no `HookReport` can carry it. */
  deferred: boolean;
}

export type HookFailureObserver = (failure: HookFailure) => void;

/**
 * The observer lives on `globalThis`, not in a module-level binding, because this module is loaded
 * TWICE in a monorepo test run and a module-level one would be two unrelated variables. Vitest
 * resolves `@porulle/core` through the package's `import` condition to `dist/`, so a plugin suite
 * runs the built executor; core's own suites and any vitest setup file import the source by
 * relative path. An observer installed on the source copy is invisible to the built one, which is
 * exactly how the first version of this instrument reported nothing while 51 hook timeouts went by.
 */
const OBSERVER_KEY = Symbol.for("@porulle/core:hook-failure-observer");

type ObserverHolder = { [OBSERVER_KEY]?: HookFailureObserver | undefined };

/** Install the observer, or pass `undefined` to remove it. Returns the previous one. */
export function observeHookFailures(next: HookFailureObserver | undefined): HookFailureObserver | undefined {
  const holder = globalThis as ObserverHolder;
  const previous = holder[OBSERVER_KEY];
  holder[OBSERVER_KEY] = next;
  return previous;
}

/**
 * Report one after-hook failure. Never throws: an observer that throws would turn a swallowed hook
 * failure into a failed write, which is the behaviour this whole path exists to prevent.
 */
export function reportHookFailure(failure: HookFailure): void {
  const observer = (globalThis as ObserverHolder)[OBSERVER_KEY];
  if (!observer) return;
  try {
    observer(failure);
  } catch {
    // An observer is an instrument. It does not get to change the outcome it is measuring.
  }
}
