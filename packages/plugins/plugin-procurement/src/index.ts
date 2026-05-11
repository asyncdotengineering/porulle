import { defineCommercePlugin } from "@porulle/core";
import { suppliers, supplierItems, purchaseOrders, purchaseOrderItems, goodsReceivedNotes, grnItems } from "./schema.js";
import { SupplierService } from "./services/supplier-service.js";
import { PurchaseOrderService } from "./services/po-service.js";
import { GRNService } from "./services/grn-service.js";
import { buildProcurementRoutes } from "./routes/procurement.js";
export type { Db } from "./types.js";
export { SupplierService } from "./services/supplier-service.js";
export { PurchaseOrderService } from "./services/po-service.js";
export { GRNService } from "./services/grn-service.js";

export function procurementPlugin() {
  return defineCommercePlugin({
    id: "procurement",
    version: "1.0.0",
    permissions: [
      { scope: "procurement:admin", description: "Approve POs, manage suppliers, accept GRNs." },
      { scope: "procurement:create", description: "Create POs, create GRNs." },
      { scope: "procurement:read", description: "View POs, GRNs, suppliers." },
    ],
    schema: () => ({ suppliers, supplierItems, purchaseOrders, purchaseOrderItems, goodsReceivedNotes, grnItems }),
    hooks: () => [],
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      return buildProcurementRoutes(new SupplierService(db), new PurchaseOrderService(db), new GRNService(db), ctx);
    },
  });
}
