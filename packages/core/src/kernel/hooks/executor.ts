import type { AfterHook, BeforeHook, HookContext, HookOperation } from "./types.js";
import type { PluginDb } from "../database/plugin-types.js";
import { deferAfterCommit } from "./deferred.js";
import { reportHookFailure } from "./failures.js";

export interface HookError {
  hookName: string;
  message: string;
}

export interface HookReport {
  errors: HookError[];
  hasErrors: boolean;
}

export function mergeHookReports(a: HookReport, b: HookReport): HookReport {
  return {
    errors: [...a.errors, ...b.errors],
    hasErrors: a.hasErrors || b.hasErrors,
  };
}

/**
 * The context a hook marked `inTransaction: true` receives.
 *
 * `inTransaction` buys ORDERING on its own — the hook runs inline, before the commit. It does not
 * make the hook's WRITES part of the transaction: `context.db` is the plugin db handle, and on a
 * two-connection driver (Neon over HTTP, where every plain query is its own request) a write on
 * that handle is not in the transaction and survives its rollback. Measured on the deployed Worker
 * on 2026-09-15: an aborted write left `entity_exists = 0` and `pending_for_aborted = 1` — a row
 * that rolled back announcing itself in the outbox whose entire purpose is committing with it.
 *
 * So the kernel hands such a hook a context it cannot get this wrong from: `db` IS the transaction.
 * A plugin author writing the obvious thing lands inside the transaction, with nothing to remember.
 *
 * `tx` can still be null here — a marked hook also fires for a write performed outside any
 * transaction, and `catalogHookContext` passes `tx: null` for one. Such a hook keeps the outside
 * connection, because that is the only connection there is; handing it nothing would silently stop
 * every non-transactional write from announcing itself, which is worse than the defect above.
 */
function inTransactionHookContext(context: HookContext): HookContext {
  if (context.tx == null) return context;
  return { ...context, db: context.tx as PluginDb };
}

/** Default hook timeout: 20 seconds */
const HOOK_TIMEOUT_MS = 20_000;

/**
 * Warn above this. The timeout is the wrong instrument for the common case: a hook does not have
 * to reach 20 s to be a problem, and by the time it does the damage is already spent.
 *
 * An in-transaction hook holds a pooled Postgres transaction for its whole duration. An
 * after-commit one extends the invocation that wrote — on Workers a promise the invocation does
 * not outlive, so the writer waits for it. `failures.ts` records what that costs unobserved: four
 * connector suites took 578.23 s instead of 27.29 s and logged 51 `deliverWebhooks timed out after
 * 20000ms`, exit 0, 22 of 22 passing. The only thing that disagreed was the wall clock.
 *
 * 100 ms matches Vendure's blocking-handler warning, and the remedy is the same one it names:
 * move non-trivial work to the job queue and let the hook enqueue it.
 */
const HOOK_SLOW_MS = 100;

function warnIfSlow(context: HookContext, hookName: string, startedAt: number, inTransaction: boolean): void {
  const elapsed = Date.now() - startedAt;
  if (elapsed <= HOOK_SLOW_MS) return;
  context.logger.warn(
    `After-hook "${hookName}" took ${elapsed}ms`,
    {
      hookName,
      elapsedMs: elapsed,
      inTransaction,
      requestId: context.requestId,
      hint: inTransaction
        ? "Runs inside the writing transaction and holds its connection for this long. Enqueue the work instead."
        : "Runs after commit but inside the same invocation, so the writer waits for it. Enqueue the work instead.",
    },
  );
}

function withTimeout<T>(promiseOrValue: Promise<T> | T, timeoutMs: number, hookName: string): Promise<T> {
  const promise = Promise.resolve(promiseOrValue);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Hook "${hookName}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function actionableHookError(error: unknown, hookName: string): Error {
  if (error instanceof Error && error.message && error.message !== "[object ErrorEvent]") {
    return error;
  }
  const candidate = error as { error?: unknown; cause?: unknown; message?: unknown } | null;
  const nested = candidate?.error ?? candidate?.cause;
  const nestedMessage = nested instanceof Error
    ? nested.message
    : nested && typeof nested === "object" && typeof (nested as { message?: unknown }).message === "string"
      ? String((nested as { message: string }).message)
      : undefined;
  const directMessage = typeof candidate?.message === "string" && candidate.message !== "[object ErrorEvent]"
    ? candidate.message
    : undefined;
  const message = nestedMessage || directMessage || String(error);
  return new Error(`Before-hook "${hookName}" failed: ${message}`, { cause: error });
}

export async function runBeforeHooks<T>(
  hooks: BeforeHook<T>[],
  data: T,
  operation: HookOperation,
  context: HookContext,
): Promise<T> {
  let current = data;
  for (const hook of hooks) {
    const hookName = hook.name || "(anonymous beforeHook)";
    try {
      current = await withTimeout(
        hook({ data: current, operation, context }),
        HOOK_TIMEOUT_MS,
        hookName,
      );
    } catch (error) {
      context.logger.error(`Before-hook "${hookName}" failed during ${operation}`, {
        error: error instanceof Error ? error.message : String(error),
        requestId: context.requestId,
      });
      throw actionableHookError(error, hookName); // Before hooks MUST succeed with actionable context.
    }
  }
  return current;
}

export async function runAfterHooks<TResult, TData = TResult>(
  hooks: AfterHook<TResult, TData>[],
  originalData: TData | null,
  committedResult: TResult,
  operation: HookOperation,
  context: HookContext,
  runsInTransaction: (hook: AfterHook<TResult, TData>) => boolean = () => false,
): Promise<HookReport> {
  const errors: HookError[] = [];
  for (const hook of hooks) {
    const hookName = hook.name || "(anonymous afterHook)";
    const runHook = () =>
      withTimeout(
        hook({
          data: originalData,
          result: committedResult,
          operation,
          context: runsInTransaction(hook)
            ? inTransactionHookContext(context)
            : { ...context, tx: null },
        }),
        HOOK_TIMEOUT_MS,
        hookName,
      );

    if (runsInTransaction(hook)) {
      const startedAt = Date.now();
      try {
        await runHook();
        warnIfSlow(context, hookName, startedAt, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ hookName, message });
        reportHookFailure({ hookName, message, deferred: false });
        context.logger.error(`After-hook "${hookName}" failed`, {
          error,
        });
      }
      continue;
    }

    const deferred = deferAfterCommit(async () => {
      const startedAt = Date.now();
      try {
        await runHook();
        warnIfSlow(context, hookName, startedAt, false);
      } catch (error) {
        // Reported rather than collected: this runs after the commit, so the HookReport below has
        // already been returned to the caller and there is nowhere else for this failure to go.
        reportHookFailure({
          hookName,
          message: error instanceof Error ? error.message : String(error),
          deferred: true,
        });
        context.logger.error(`After-commit hook "${hookName}" failed`, {
          error,
        });
      }
    });

    if (!deferred) {
      const startedAt = Date.now();
      try {
        await runHook();
        warnIfSlow(context, hookName, startedAt, false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ hookName, message });
        reportHookFailure({ hookName, message, deferred: false });
        context.logger.error(`After-hook "${hookName}" failed`, {
          error,
        });
      }
    }
  }
  // After-commit hook failures are logged when the transaction drains; they
  // cannot appear here because deferred hooks run after commit, once the
  // service method has already returned its Result.
  return { errors, hasErrors: errors.length > 0 };
}
