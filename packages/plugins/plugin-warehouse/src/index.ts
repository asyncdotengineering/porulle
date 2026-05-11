import { defineCommercePlugin } from "@porulle/core";
import { warehouseBins, stockTransfers, stockTransferItems, wastageNotes, wastageNoteItems, stockReconciliations, reconciliationItems } from "./schema.js";
import { TransferService } from "./services/transfer-service.js";
import { WastageService } from "./services/wastage-service.js";
import { ReconciliationService } from "./services/reconciliation-service.js";
import { buildWarehouseRoutes } from "./routes/warehouse.js";
export type { Db } from "./types.js";
export { TransferService } from "./services/transfer-service.js";
export { WastageService } from "./services/wastage-service.js";
export { ReconciliationService } from "./services/reconciliation-service.js";

export function warehousePlugin() {
  return defineCommercePlugin({
    id: "warehouse",
    version: "1.0.0",
    permissions: [
      { scope: "warehouse:admin", description: "Approve transfers, wastage, reconciliations." },
      { scope: "warehouse:operate", description: "Create transfers, wastage notes, reconciliations." },
      { scope: "warehouse:read", description: "View transfers, wastage, reconciliations." },
    ],
    schema: () => ({ warehouseBins, stockTransfers, stockTransferItems, wastageNotes, wastageNoteItems, stockReconciliations, reconciliationItems }),
    hooks: () => [],
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      return buildWarehouseRoutes(new TransferService(db), new WastageService(db), new ReconciliationService(db), ctx);
    },
  });
}
