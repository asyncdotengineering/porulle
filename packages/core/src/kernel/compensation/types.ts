import type { TxContext } from "../database/tx-context.js";
import type { HookContext } from "../hooks/types.js";
import type { Result } from "../result.js";
import type { CompensationFailuresRepository } from "./repository.js";

/**
 * CompensationContext carries the transaction and hook context into
 * both the run and compensate functions. Steps have access to services,
 * the actor, and the logger through ctx.hook.
 */
export interface CompensationContext {
  tx: TxContext | null;
  hook: HookContext;
  failureRepository?: CompensationFailuresRepository;
  correlationId?: string;
  chainName?: string;
}

/**
 * A Step is one unit of work in a compensation chain.
 *
 * TInput is the data the step receives (typically the shared checkout data object).
 * TOutput is what the step produces. This same value is passed to compensate()
 * so the compensate function has everything it needs to reverse the work.
 */
export interface Step<TInput, TOutput> {
  id: string;
  run: (input: TInput, ctx: CompensationContext) => Promise<Result<TOutput>>;
  compensate?: (output: TOutput, ctx: CompensationContext) => Promise<void>;
}
