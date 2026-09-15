import { observeHookFailures, type HookFailure } from "../kernel/hooks/failures.js";

/**
 * Collected after-hook failures for the test currently running, and the per-test allowance for the
 * ones a suite causes on purpose.
 *
 * The state lives here rather than in the vitest setup file so that a suite importing
 * `allowHookFailure` from `@porulle/core/testing` and the setup file that reads it resolve to the
 * same module instance.
 */
/**
 * On `globalThis` for the same reason the observer is: this module is loaded once as source (by the
 * vitest setup file) and once as `dist/` (by anything importing `@porulle/core/testing`), so a
 * suite calling `allowHookFailure` would otherwise be writing to a different Set from the one the
 * setup file reads.
 */
const STATE_KEY = Symbol.for("@porulle/core:hook-failure-state");

type State = { seen: HookFailure[]; allowed: Set<string> };
type StateHolder = { [STATE_KEY]?: State };

function state(): State {
  const holder = globalThis as StateHolder;
  holder[STATE_KEY] ??= { seen: [], allowed: new Set<string>() };
  return holder[STATE_KEY];
}

/**
 * Permit one named hook to fail during the current test without failing it.
 *
 * Per test and per hook on purpose: a suite that deliberately throws from `myBrokenHook` still
 * fails if `deliverWebhooks` deadlocks alongside it, which a global mute would hide. The allowance
 * is cleared before every test, so it has to be asked for where it is meant.
 */
export function allowHookFailure(hookName: string): void {
  state().allowed.add(hookName);
}

/** Every failure recorded for the current test, allowed or not. */
export function recordedHookFailures(): readonly HookFailure[] {
  return state().seen;
}

export function resetHookFailures(): void {
  const current = state();
  current.seen.length = 0;
  current.allowed.clear();
}

export function armHookFailureCollector(): void {
  observeHookFailures((failure) => state().seen.push(failure));
}

/**
 * The message for an unallowed failure, or undefined when there is nothing to report.
 *
 * A hook TIMEOUT is called out separately: a hook that throws is usually the suite's own doing,
 * while a hook that times out is almost always deadlocked against the transaction holding its
 * connection — a defect in the code under test, not in the test.
 */
export function unallowedHookFailureMessage(): string | undefined {
  const { seen, allowed } = state();
  const unallowed = seen.filter((failure) => !allowed.has(failure.hookName));
  if (unallowed.length === 0) return undefined;

  const timeouts = unallowed.filter((failure) => / timed out after \d+ms$/.test(failure.message));
  const lines = unallowed.map(
    (failure) => `  ${failure.deferred ? "after-commit" : "after"}-hook "${failure.hookName}": ${failure.message}`,
  );

  return [
    `${unallowed.length} after-hook failure(s) during this test:`,
    ...lines,
    "",
    timeouts.length > 0
      ? `${timeouts.length} of them TIMED OUT. A hook that times out is almost always blocked on the ` +
        "connection held by the transaction it was fired from — check that the write path establishes " +
        "an after-commit boundary rather than running the hook inside the transaction."
      : "An after-hook failure never fails the write it announces, so without this check the test " +
        "passes and the failure is only visible in a log.",
    "",
    "If the suite causes this on purpose, call allowHookFailure(\"<hookName>\") in that test.",
  ].join("\n");
}
