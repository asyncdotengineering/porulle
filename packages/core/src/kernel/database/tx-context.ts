import { randomUUID } from "node:crypto";
import type { Actor } from "../../auth/types.js";
import type { DatabaseAdapter } from "./adapter.js";

export interface TxContext<TTx = unknown> {
  tx: TTx;
  actor: Actor | null;
  requestId: string;
}

export interface WithTransactionOptions {
  actor: Actor | null;
  requestId?: string;
}

export function createTxContext<TTx>(
  tx: TTx,
  options: WithTransactionOptions,
): TxContext<TTx> {
  return {
    tx,
    actor: options.actor,
    requestId: options.requestId ?? randomUUID(),
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

export function reuseOrCreateTxContext<TTx>(
  tx: TTx,
  options: WithTransactionOptions,
  existing?: TxContext<TTx> | null,
): TxContext<TTx> {
  if (existing) {
    return existing;
  }
  return createTxContext(tx, options);
}
