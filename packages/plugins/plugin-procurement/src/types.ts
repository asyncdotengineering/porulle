export type { PluginDb as Db } from "@porulle/core";
import type { suppliers, supplierItems, purchaseOrders, purchaseOrderItems, goodsReceivedNotes, grnItems } from "./schema.js";
export type Supplier = typeof suppliers.$inferSelect;
export type SupplierItem = typeof supplierItems.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderItem = typeof purchaseOrderItems.$inferSelect;
export type GoodsReceivedNote = typeof goodsReceivedNotes.$inferSelect;
export type GRNItem = typeof grnItems.$inferSelect;
export type POStatus = "draft" | "pending_approval" | "approved" | "sent" | "partially_received" | "received" | "cancelled";
