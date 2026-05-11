import type { TxContext } from "../../../kernel/database/tx-context.js";

export interface SearchRepository {
  ping(ctx: TxContext): Promise<void>;
}
