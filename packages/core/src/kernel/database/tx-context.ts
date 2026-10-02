import { randomUUID } from "node:crypto";
import type { Actor } from "../../auth/types.js";
import type { DatabaseAdapter } from "./adapter.js";

export interface TxContext<TTx = unknown> {
  tx: TTx;
  actor: Actor | null;
  requestId: string;
  hookContext?: Record<string, unknown>;
}

export interface HookContextCarrier {
  hookContext?: Record<string, unknown>;
}

export type CatalogWriteContext<TTx = unknown> = TxContext<TTx> | HookContextCarrier;

export interface WithTransactionOptions {
  actor: Actor | null;
  requestId?: string;
  hookContext?: Record<string, unknown>;
}

export function createTxContext<TTx>(
  tx: TTx,
  options: WithTransactionOptions,
): TxContext<TTx> {
  return {
    tx,
    actor: options.actor,
    requestId: options.requestId ?? randomUUID(),
    ...(options.hookContext ? { hookContext: options.hookContext } : {}),
  };
}

export async function withTransaction<TDb, TTx, TResult>(
  database: DatabaseAdapter<TDb, TTx>,
  options: WithTransactionOptions,
  fn: (ctx: TxContext<TTx>) => Promise<TResult>,
): Promise<TResult> {
  return database.transaction(async (tx) => {
    return fn(createTxContext(tx, options));
  });
}


export function resolveWriteContextHookContext(ctx?: CatalogWriteContext): Record<string, unknown> | undefined {
  return ctx?.hookContext;
}

export function isWriteContextTransactional<TTx>(ctx?: CatalogWriteContext<TTx>): ctx is TxContext<TTx> {
  return ctx != null && "tx" in ctx && ctx.tx != null;
}
