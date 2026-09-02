import { TaskNonRetryableError } from "./types.js";
import type { TaskStep } from "./types.js";

/**
 * Pass-through `TaskStep` for pull-based engines with no durable step primitive:
 * `do` runs `fn` immediately, `sleep` waits in-process. Lets a handler written
 * against `ctx.step` run unchanged on the drizzle engine.
 */
export function createPassThroughTaskStep(): TaskStep {
  return {
    async do(_name, fn, options) {
      try {
        return await fn();
      } catch (error) {
        if (options?.nonRetryable && !(error instanceof TaskNonRetryableError)) {
          throw new TaskNonRetryableError(
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
    },
    async sleep(_name, ms) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
  };
}
