export type { PluginDb as Db } from "@porulle/core";
import type { warehouseBins, stockTransfers, stockTransferItems, wastageNotes, wastageNoteItems, stockReconciliations, reconciliationItems } from "./schema.js";
export type WarehouseBin = typeof warehouseBins.$inferSelect;
export type StockTransfer = typeof stockTransfers.$inferSelect;
export type StockTransferItem = typeof stockTransferItems.$inferSelect;
export type WastageNote = typeof wastageNotes.$inferSelect;
export type WastageNoteItem = typeof wastageNoteItems.$inferSelect;
export type StockReconciliation = typeof stockReconciliations.$inferSelect;
export type ReconciliationItem = typeof reconciliationItems.$inferSelect;
