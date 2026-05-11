import type { TxContext } from "../../../kernel/database/tx-context.js";

export interface AnalyticsRepository {
  ping(ctx: TxContext): Promise<void>;
}
