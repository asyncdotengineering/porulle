import type { TxContext } from "../../../kernel/database/tx-context.js";

export interface ShippingRepository {
  ping(ctx: TxContext): Promise<void>;
}
