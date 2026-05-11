/**
 * INVENTORY PLUGINS VALIDATION — Against Real PostgreSQL
 *
 * Exercises all 3 supply chain plugins (UOM, Procurement, Warehouse)
 * via direct service calls, then queries PostgreSQL to verify every row.
 *
 * Run: DATABASE_URL=postgres://localhost:5432/uc_inventory_validation bun run tsx src/scripts/inventory-validation.ts
 */

import { createKernel, ensureDefaultOrg, DEFAULT_ORG_ID } from "@porulle/core";
import { sql } from "@porulle/core/drizzle";
import { UOMService } from "@porulle/plugin-uom";
import { SupplierService, PurchaseOrderService, GRNService } from "@porulle/plugin-procurement";
import { TransferService, WastageService, ReconciliationService } from "@porulle/plugin-warehouse";

const configOrPromise = (await import("../../commerce.config.js")).default;
const config = configOrPromise instanceof Promise ? await configOrPromise : configOrPromise;
const kernel = createKernel(config);
await ensureDefaultOrg(kernel.database.db);

const db = kernel.database.db as unknown as import("@porulle/core").PluginDb;
type RawDb = { execute: (q: unknown) => Promise<unknown> };
const rawDb = kernel.database.db as unknown as RawDb;
const q = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> => {
  const result = await rawDb.execute(query);
  return Array.isArray(result) ? result as Record<string, unknown>[] : (result as { rows: Record<string, unknown>[] }).rows;
};

const ORG = DEFAULT_ORG_ID;
let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) { console.log(`  [PASS] ${label}`); passed++; }
  else { console.log(`  [FAIL] ${label}${detail ? ` -- ${detail}` : ""}`); failed++; }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1: UOM
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 1: Units of Measure ===\n");

const uomSvc = new UOMService(db);

const kg = await uomSvc.createUnit(ORG, { code: "kg", name: "Kilogram", category: "weight", isBaseUnit: true });
const g = await uomSvc.createUnit(ORG, { code: "g", name: "Gram", category: "weight" });
const pc = await uomSvc.createUnit(ORG, { code: "pc", name: "Piece", category: "count", isBaseUnit: true });
const cs = await uomSvc.createUnit(ORG, { code: "case", name: "Case", category: "count" });
assert(kg.ok && g.ok && pc.ok && cs.ok, "Created 4 units: kg, g, pc, case");

const kgId = kg.ok ? kg.value.id : "";
const gId = g.ok ? g.value.id : "";
const pcId = pc.ok ? pc.value.id : "";
const csId = cs.ok ? cs.value.id : "";

// Conversions
await uomSvc.createConversion(ORG, { fromUnitId: kgId, toUnitId: gId, factor: 10000000 }); // 1kg = 1000g * 10000
await uomSvc.createConversion(ORG, { fromUnitId: csId, toUnitId: pcId, factor: 240000 }); // 1case = 24pc * 10000

// Convert 2.5kg -> g
const conv1 = await uomSvc.convert(ORG, { fromUnitId: kgId, toUnitId: gId, quantity: 25000 });
assert(conv1.ok && conv1.value.result === 25000000, `2.5kg -> ${conv1.ok ? conv1.value.result : "?"} (expected 25000000)`);

// Convert 3 cases -> pc
const conv2 = await uomSvc.convert(ORG, { fromUnitId: csId, toUnitId: pcId, quantity: 3 });
assert(conv2.ok && conv2.value.result === 72, `3 cases -> ${conv2.ok ? conv2.value.result : "?"} pc (expected 72)`);

// Entity UOM with yield
const entityId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
await uomSvc.setEntityUom(ORG, { entityId, purchaseUomId: kgId, stockUomId: gId, saleUomId: gId, yieldPercentage: 60 });
const yieldCalc = await uomSvc.calculateYield(60, 200);
assert(yieldCalc.ok && yieldCalc.value.purchaseQuantity === 334, `Yield: need 200g EP -> purchase ${yieldCalc.ok ? yieldCalc.value.purchaseQuantity : "?"} AP (expected 334)`);

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2: PROCUREMENT
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 2: Procurement ===\n");

const supplierSvc = new SupplierService(db);
const poSvc = new PurchaseOrderService(db);
const grnSvc = new GRNService(db);

// Create supplier
const supplier = await supplierSvc.create(ORG, { name: "Fresh Farms Co", code: "FF01", contactEmail: "info@freshfarms.local", paymentTermsDays: 30 });
assert(supplier.ok, "Supplier 'Fresh Farms' created");
const supplierId = supplier.ok ? supplier.value.id : "";

// Link items
await supplierSvc.addItem(supplierId, { entityId, unitCost: 350, supplierSku: "FF-BEEF-200G", leadTimeDays: 2 });
const entity2 = "c3d4e5f6-a7b8-4c9d-ae1f-2a3b4c5d6e7f";
await supplierSvc.addItem(supplierId, { entityId: entity2, unitCost: 80, supplierSku: "FF-BUN-1PC" });

// Create PO
const whId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const po = await poSvc.create(ORG, {
  supplierId, warehouseId: whId, requestedBy: "manager-1",
  items: [
    { entityId, itemName: "Beef Patty 200g", quantityOrdered: 100, unitCost: 350 },
    { entityId: entity2, itemName: "Brioche Buns", quantityOrdered: 200, unitCost: 80 },
  ],
});
assert(po.ok, "PO created");
const poId = po.ok ? po.value.id : "";
assert(po.ok && po.value.subtotal === 51000, `PO subtotal: ${po.ok ? po.value.subtotal : 0} (100*350 + 200*80 = 51000)`);

// Submit + approve
await poSvc.submit(ORG, poId);
const approved = await poSvc.approve(ORG, poId, "manager-1");
assert(approved.ok && approved.value.status === "approved", `PO status: ${approved.ok ? approved.value.status : "?"}`);

// Create GRN with discrepancy
const poDetail = await poSvc.getById(ORG, poId);
const poItems = poDetail.ok ? poDetail.value.items : [];

const grn = await grnSvc.create(ORG, {
  poId, supplierId, warehouseId: whId, receivedBy: "warehouse-staff-1",
  items: [
    { poItemId: poItems[0]!.id, entityId, quantityOrdered: 100, quantityReceived: 95, quantityAccepted: 90, quantityRejected: 5, rejectionReason: "Damaged packaging", batchNumber: "BATCH-2026-001", unitCost: 350 },
    { poItemId: poItems[1]!.id, entityId: entity2, quantityOrdered: 200, quantityReceived: 200, quantityAccepted: 200, unitCost: 80 },
  ],
});
assert(grn.ok, "GRN created with discrepancy (5 rejected)");

// Accept GRN
const accepted = await grnSvc.accept(ORG, grn.ok ? grn.value.id : "");
assert(accepted.ok && accepted.value.status === "accepted_with_discrepancy", `GRN status: ${accepted.ok ? accepted.value.status : "?"}`);

// Check PO status updated
const poAfterGrn = await poSvc.getById(ORG, poId);
assert(poAfterGrn.ok && poAfterGrn.value.po.status === "partially_received", `PO status after GRN: ${poAfterGrn.ok ? poAfterGrn.value.po.status : "?"}`);

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3: WAREHOUSE
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 3: Warehouse ===\n");

const transferSvc = new TransferService(db);
const wastageSvc = new WastageService(db);
const recSvc = new ReconciliationService(db);

const whA = "d4e5f6a7-b8c9-4d0e-af2a-3b4c5d6e7f8a";
const whB = "e5f6a7b8-c9d0-4e1f-bf2a-4c5d6e7f8a9b";

// Transfer
const transfer = await transferSvc.create(ORG, {
  fromWarehouseId: whA, toWarehouseId: whB, requestedBy: "manager-1",
  items: [
    { entityId, itemName: "Flour 25kg", quantityRequested: 10 },
    { entityId: entity2, itemName: "Sugar 10kg", quantityRequested: 5 },
  ],
});
assert(transfer.ok, "Stock transfer created");
const transferId = transfer.ok ? transfer.value.id : "";

// Lifecycle
await transferSvc.approve(ORG, transferId, "manager-1");
await transferSvc.dispatch(ORG, transferId);
const transferDetail = await transferSvc.getById(ORG, transferId);
const tItems = transferDetail.ok ? transferDetail.value.items : [];
await transferSvc.receive(ORG, transferId, tItems.map(i => ({ itemId: i.id, quantityReceived: i.quantityRequested })));
const received = await transferSvc.getById(ORG, transferId);
assert(received.ok && received.value.transfer.status === "received", `Transfer status: ${received.ok ? received.value.transfer.status : "?"}`);

// Wastage
const wastage = await wastageSvc.create(ORG, {
  warehouseId: whA, type: "spoilage", recordedBy: "kitchen-staff-1",
  items: [
    { entityId, itemName: "Lettuce", quantity: 5, unitCost: 200, reason: "Wilted" },
    { entityId: entity2, itemName: "Tomatoes", quantity: 3, unitCost: 150, reason: "Mold" },
  ],
});
assert(wastage.ok && wastage.value.totalCost === 1450, `Wastage cost: ${wastage.ok ? wastage.value.totalCost : 0} (5*200+3*150=1450)`);
await wastageSvc.approve(ORG, wastage.ok ? wastage.value.id : "", "manager-1");

// Reconciliation
const rec = await recSvc.create(ORG, {
  warehouseId: whA, countedBy: "warehouse-staff-1",
  items: [
    { entityId, itemName: "Flour 25kg", systemQuantity: 100, physicalQuantity: 95, notes: "5 bags unaccounted" },
    { entityId: entity2, itemName: "Sugar 10kg", systemQuantity: 50, physicalQuantity: 50 },
  ],
});
assert(rec.ok, "Reconciliation created with variance");
const recId = rec.ok ? rec.value.id : "";
await recSvc.submit(ORG, recId);
await recSvc.approve(ORG, recId, "manager-1");
const recDetail = await recSvc.getById(ORG, recId);
if (recDetail.ok) {
  const flour = recDetail.value.items.find(i => i.itemName === "Flour 25kg");
  const sugar = recDetail.value.items.find(i => i.itemName === "Sugar 10kg");
  assert(flour?.variance === -5 && flour?.adjustmentMade === true, `Flour: variance=${flour?.variance}, adjusted=${flour?.adjustmentMade}`);
  assert(sugar?.variance === 0 && sugar?.adjustmentMade === false, `Sugar: variance=${sugar?.variance}, adjusted=${sugar?.adjustmentMade}`);
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 4: DIRECT POSTGRESQL VALIDATION
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 4: PostgreSQL Validation ===\n");

// UOM tables
const dbUnits = await q(sql`SELECT code, name, category, is_base_unit FROM units_of_measure WHERE organization_id = ${ORG} ORDER BY code`);
assert(dbUnits.length === 4, `units_of_measure: ${dbUnits.length} rows`);
console.log(`  Units: ${dbUnits.map(u => u.code).join(", ")}`);

const dbConv = await q(sql`SELECT factor FROM uom_conversions WHERE organization_id = ${ORG}`);
assert(dbConv.length === 2, `uom_conversions: ${dbConv.length} rows`);

const dbEntityUom = await q(sql`SELECT yield_percentage FROM entity_uom WHERE organization_id = ${ORG}`);
assert(dbEntityUom.length === 1, `entity_uom: ${dbEntityUom.length} row, yield=${dbEntityUom[0]?.yield_percentage}%`);

// Procurement tables
const dbSuppliers = await q(sql`SELECT name, code FROM suppliers WHERE organization_id = ${ORG}`);
assert(dbSuppliers.length === 1, `suppliers: ${dbSuppliers.length} row (${dbSuppliers[0]?.name})`);

const dbSupItems = await q(sql`SELECT supplier_sku, unit_cost, lead_time_days FROM supplier_items`);
assert(dbSupItems.length === 2, `supplier_items: ${dbSupItems.length} rows`);

const dbPOs = await q(sql`SELECT po_number, status, subtotal, approved_by FROM purchase_orders WHERE organization_id = ${ORG}`);
assert(dbPOs.length === 1, `purchase_orders: ${dbPOs.length} row`);
assert(dbPOs[0]!.status === "partially_received", `PO status: ${dbPOs[0]!.status}`);
assert(dbPOs[0]!.subtotal === 51000, `PO subtotal: ${dbPOs[0]!.subtotal}`);

const dbPOItems = await q(sql`SELECT item_name, quantity_ordered, quantity_received FROM purchase_order_items ORDER BY item_name`);
assert(dbPOItems.length === 2, `purchase_order_items: ${dbPOItems.length} rows`);
console.log(`  PO items: ${dbPOItems.map(i => `${i.item_name} (ordered=${i.quantity_ordered}, received=${i.quantity_received})`).join("; ")}`);

const dbGRNs = await q(sql`SELECT grn_number, status FROM goods_received_notes WHERE organization_id = ${ORG}`);
assert(dbGRNs.length === 1, `goods_received_notes: ${dbGRNs.length} row, status=${dbGRNs[0]!.status}`);

const dbGRNItems = await q(sql`SELECT quantity_ordered, quantity_received, quantity_accepted, quantity_rejected, rejection_reason, batch_number FROM grn_items ORDER BY quantity_ordered DESC`);
assert(dbGRNItems.length === 2, `grn_items: ${dbGRNItems.length} rows`);
const rejectedItem = dbGRNItems.find(i => Number(i.quantity_rejected) > 0);
assert(rejectedItem !== undefined, `GRN discrepancy: ${rejectedItem?.quantity_rejected} rejected (${rejectedItem?.rejection_reason}), batch=${rejectedItem?.batch_number}`);

// Warehouse tables
const dbTransfers = await q(sql`SELECT transfer_number, status, from_warehouse_id, to_warehouse_id FROM stock_transfers WHERE organization_id = ${ORG}`);
assert(dbTransfers.length === 1, `stock_transfers: ${dbTransfers.length} row, status=${dbTransfers[0]!.status}`);

const dbTransferItems = await q(sql`SELECT item_name, quantity_requested, quantity_dispatched, quantity_received FROM stock_transfer_items`);
assert(dbTransferItems.length === 2, `stock_transfer_items: ${dbTransferItems.length} rows`);
assert(dbTransferItems.every(i => i.quantity_received === i.quantity_requested), "All transfer items fully received");

const dbWastage = await q(sql`SELECT note_number, type, total_cost, approved_by FROM wastage_notes WHERE organization_id = ${ORG}`);
assert(dbWastage.length === 1, `wastage_notes: ${dbWastage.length} row, cost=${dbWastage[0]!.total_cost}, approved_by=${dbWastage[0]!.approved_by}`);

const dbWastageItems = await q(sql`SELECT item_name, quantity, unit_cost, total_cost, reason FROM wastage_note_items`);
assert(dbWastageItems.length === 2, `wastage_note_items: ${dbWastageItems.length} rows`);
console.log(`  Wastage: ${dbWastageItems.map(i => `${i.item_name} x${i.quantity} ($${Number(i.total_cost) / 100}) - ${i.reason}`).join("; ")}`);

const dbRecs = await q(sql`SELECT reconciliation_number, status, approved_by FROM stock_reconciliations WHERE organization_id = ${ORG}`);
assert(dbRecs.length === 1, `stock_reconciliations: ${dbRecs.length} row, status=${dbRecs[0]!.status}`);

const dbRecItems = await q(sql`SELECT item_name, system_quantity, physical_quantity, variance, adjustment_made FROM reconciliation_items ORDER BY item_name`);
assert(dbRecItems.length === 2, `reconciliation_items: ${dbRecItems.length} rows`);
console.log(`  Reconciliation: ${dbRecItems.map(i => `${i.item_name}: system=${i.system_quantity}, physical=${i.physical_quantity}, variance=${i.variance}, adjusted=${i.adjustment_made}`).join("; ")}`);

// Org isolation
const orgCounts = await q(sql`
  SELECT 'units' AS tbl, COUNT(DISTINCT organization_id)::int AS orgs FROM units_of_measure
  UNION ALL SELECT 'suppliers', COUNT(DISTINCT organization_id)::int FROM suppliers
  UNION ALL SELECT 'pos', COUNT(DISTINCT organization_id)::int FROM purchase_orders
  UNION ALL SELECT 'transfers', COUNT(DISTINCT organization_id)::int FROM stock_transfers
  UNION ALL SELECT 'wastage', COUNT(DISTINCT organization_id)::int FROM wastage_notes
  UNION ALL SELECT 'recon', COUNT(DISTINCT organization_id)::int FROM stock_reconciliations
`);
assert(orgCounts.every(r => Number(r.orgs) <= 1), "All data scoped to single org (no leakage)");

// ═══════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(60));
console.log(`  INVENTORY VALIDATION: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  console.log("\n  VERDICT: ISSUES FOUND\n");
} else {
  console.log("\n  VERDICT: ALL 3 INVENTORY PLUGINS VERIFIED AGAINST POSTGRESQL\n");
  console.log("  Tables validated:");
  console.log("    UOM: units_of_measure (4), uom_conversions (2), entity_uom (1)");
  console.log("    Procurement: suppliers (1), supplier_items (2), purchase_orders (1),");
  console.log("      purchase_order_items (2), goods_received_notes (1), grn_items (2)");
  console.log("    Warehouse: stock_transfers (1), stock_transfer_items (2),");
  console.log("      wastage_notes (1), wastage_note_items (2),");
  console.log("      stock_reconciliations (1), reconciliation_items (2)\n");
}

process.exit(failed > 0 ? 1 : 0);
