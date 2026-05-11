import { resolveOrgId } from "../../auth/org.js";
import type { CompensationContext, Step } from "./types.js";
import type { Result } from "../result.js";

function errorToRecordPayload(
  err: unknown,
): { message: string; code?: string; details?: unknown } {
  if (err && typeof err === "object" && "message" in err) {
    const o = err as {
      message: unknown;
      code?: unknown;
      details?: unknown;
    };
    const message = String(o.message);
    const code = o.code != null ? String(o.code) : undefined;
    const details = o.details !== undefined ? o.details : undefined;
    return {
      message,
      ...(code != null ? { code } : {}),
      ...(details !== undefined ? { details } : {}),
    };
  }
  return { message: String(err) };
}

function compensationThrownToPayload(
  err: unknown,
): { message: string; stack?: string; details?: unknown } {
  if (err instanceof Error) {
    return {
      message: err.message,
      ...(err.stack != null ? { stack: err.stack } : {}),
    };
  }
  return { message: String(err) };
}

/**
 * AnyStep erases the output type parameter so that heterogeneous step
 * arrays can be passed to runCompensationChain without variance issues
 * under exactOptionalPropertyTypes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- erases output type for heterogeneous step arrays; unknown breaks contravariance on compensate()
type AnyStep<TInput> = Step<TInput, any>;

/**
 * Runs a list of steps in order. If any step fails, compensates all
 * previously completed steps in reverse. Steps share the same input
 * object (they may mutate it to enrich downstream steps, following
 * the same pattern established by BeforeHooks).
 *
 * Compensation failures are logged but do not override the original error.
 * A failed compensation is a separate operational concern that requires
 * manual review — it should never mask the root cause returned to the caller.
 */
export async function runCompensationChain<TInput>(
  steps: ReadonlyArray<AnyStep<TInput>>,
  input: TInput,
  ctx: CompensationContext,
): Promise<Result<TInput>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches AnyStep output erasure
  const completed: Array<{ step: AnyStep<TInput>; output: any }> = [];

  for (const step of steps) {
    const result = await step.run(input, ctx);

    if (!result.ok) {
      const originalErr = result.error;
      ctx.hook.logger.error(
        `Compensation chain failed at step "${step.id}". ` +
          `Running ${completed.length} compensation(s).`,
        { error: originalErr },
      );

      // Compensate in reverse order — most recently completed step first
      for (const done of [...completed].reverse()) {
        if (!done.step.compensate) continue;
        try {
          await done.step.compensate(done.output, ctx);
          ctx.hook.logger.info(`Compensated step "${done.step.id}"`);
        } catch (compensateError) {
          ctx.hook.logger.error(
            `Compensation for step "${done.step.id}" failed. Manual review required.`,
            { compensateError },
          );
          if (ctx.failureRepository) {
            try {
              const orgId = resolveOrgId(ctx.hook.actor);
              const recordResult = await ctx.failureRepository.record(
                {
                  organizationId: orgId,
                  correlationId: ctx.correlationId ?? "",
                  chainName: ctx.chainName ?? "unknown",
                  stepName: done.step.id,
                  originalError: errorToRecordPayload(originalErr),
                  compensationError: compensationThrownToPayload(compensateError),
                },
                ctx.tx ?? undefined,
              );
              if (!recordResult.ok) {
                console.warn(
                  "[compensation] Failed to persist compensation failure:",
                  recordResult.error,
                );
              }
            } catch (persistErr) {
              console.warn(
                "[compensation] Failed to persist compensation failure:",
                persistErr,
              );
            }
          }
        }
      }

      return result;
    }

    completed.push({ step, output: result.value });
  }

  return { ok: true, value: input };
}
