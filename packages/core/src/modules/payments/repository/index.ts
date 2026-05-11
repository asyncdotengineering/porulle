import type { TxContext } from "../../../kernel/database/tx-context.js";

export interface PaymentsRepository {
  ping(ctx: TxContext): Promise<void>;
}
