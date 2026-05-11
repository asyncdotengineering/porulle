import type { AfterHook, BeforeHook, HookContext, HookOperation } from "./types.js";

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

/** Default hook timeout: 20 seconds */
const HOOK_TIMEOUT_MS = 20_000;

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
      throw error; // Re-throw — beforeHooks MUST succeed
    }
  }
  return current;
}

export async function runAfterHooks<T>(
  hooks: AfterHook<T>[],
  originalData: T | null,
  committedResult: T,
  operation: HookOperation,
  context: HookContext,
): Promise<HookReport> {
  const errors: HookError[] = [];
  for (const hook of hooks) {
    const hookName = hook.name || "(anonymous afterHook)";
    try {
      await withTimeout(
        hook({
          data: originalData,
          result: committedResult,
          operation,
          context,
        }),
        HOOK_TIMEOUT_MS,
        hookName,
      );
    } catch (error) {
      errors.push({
        hookName,
        message: error instanceof Error ? error.message : String(error),
      });
      context.logger.error(`After-hook "${hookName}" failed`, {
        error,
      });
    }
  }
  return { errors, hasErrors: errors.length > 0 };
}
