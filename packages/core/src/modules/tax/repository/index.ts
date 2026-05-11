import type { TxContext } from "../../../kernel/database/tx-context.js";

export interface TaxRepository {
  ping(ctx: TxContext): Promise<void>;
}
