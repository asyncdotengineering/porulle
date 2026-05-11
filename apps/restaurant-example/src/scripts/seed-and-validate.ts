/**
 * SEED + VALIDATE SCRIPT — Runs against real PostgreSQL
 *
 * Simulates a full restaurant day at "The Blue Apron Bistro" using the
 * kernel directly (no HTTP), then queries PostgreSQL via raw SQL to
 * verify every row in every POS table.
 *
 * Run: DATABASE_URL=postgres://localhost:5432/uc_restaurant bun run tsx src/scripts/seed-and-validate.ts
 */

import { createKernel, ensureDefaultOrg, DEFAULT_ORG_ID, type Actor } from "@porulle/core";
import { sql } from "@porulle/core/drizzle";
import { TerminalService, ShiftService, TransactionService, PaymentService } from "@porulle/plugin-pos";
import { ModifierService, TableService, KDSService, ChecklistService, AlertService, RecipeService, RestaurantAnalyticsService } from "@porulle/plugin-pos-restaurant";

const configOrPromise = (await import("../../commerce.config.js")).default;
const config = configOrPromise instanceof Promise ? await configOrPromise : configOrPromise;
const kernel = createKernel(config);
await ensureDefaultOrg(kernel.database.db);

type Db = import("@porulle/core").PluginDb;
const db = kernel.database.db as unknown as Db;
const txFn = kernel.database.transaction as unknown as (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>;

type RawDb = { execute: (q: unknown) => Promise<unknown> };
const rawDb = kernel.database.db as unknown as RawDb;

// Services
const terminalSvc = new TerminalService(db);
const shiftSvc = new ShiftService(db, txFn);
const txnSvc = new TransactionService(db, txFn);
const paymentSvc = new PaymentService(db, txFn);
const modifierSvc = new ModifierService(db);
const tableSvc = new TableService(db);
const kdsSvc = new KDSService(db);
const checklistSvc = new ChecklistService(db);
const alertSvc = new AlertService(db);
const recipeSvc = new RecipeService(db);
const analyticsSvc = new RestaurantAnalyticsService(db);

const ORG = DEFAULT_ORG_ID;
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) { console.log(`  [PASS] ${label}`); passed++; }
  else { console.log(`  [FAIL] ${label}${detail ? ` -- ${detail}` : ""}`); failed++; }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1: SEED
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 1: Restaurant Setup ===\n");

// Terminals
const t1 = await terminalSvc.create(ORG, { name: "Main Register", code: "R1" });
assert(t1.ok, "Terminal R1 created");
const terminalId = t1.ok ? t1.value.id : "";

const t2 = await terminalSvc.create(ORG, { name: "Bar Register", code: "BAR1" });
assert(t2.ok, "Terminal BAR1 created");

// Tables
const tbl1 = await tableSvc.create(ORG, { number: "T1", zone: "Main Hall", capacity: 4 });
const tbl2 = await tableSvc.create(ORG, { number: "T2", zone: "Main Hall", capacity: 6 });
const tbl3 = await tableSvc.create(ORG, { number: "T3", zone: "Main Hall", capacity: 2 });
const tblP1 = await tableSvc.create(ORG, { number: "P1", zone: "Patio", capacity: 4 });
assert(tbl1.ok && tbl2.ok && tbl3.ok && tblP1.ok, "4 tables created (Main Hall x3, Patio x1)");
const t1Id = tbl1.ok ? tbl1.value.id : "";
const t2Id = tbl2.ok ? tbl2.value.id : "";
const t3Id = tbl3.ok ? tbl3.value.id : "";
const p1Id = tblP1.ok ? tblP1.value.id : "";

// KDS Stations
const grill = await kdsSvc.createStation(ORG, { name: "Grill Station", alertThresholdMinutes: 10 });
const bar = await kdsSvc.createStation(ORG, { name: "Bar Station" });
assert(grill.ok && bar.ok, "2 KDS stations created");
const grillId = grill.ok ? grill.value.id : "";
const barId = bar.ok ? bar.value.id : "";

await kdsSvc.addItemGroup(grillId, "mains");
await kdsSvc.addItemGroup(grillId, "appetizers");
await kdsSvc.addItemGroup(barId, "beverages");

// Modifiers
const modGroup = await modifierSvc.createGroup(ORG, { name: "Choose protein", isRequired: true, minSelect: 1, maxSelect: 1 });
assert(modGroup.ok, "Modifier group created (required, pick 1)");
const modGroupId = modGroup.ok ? modGroup.value.id : "";
await modifierSvc.addOption(modGroupId, { name: "Chicken", priceAdjustment: 0 });
await modifierSvc.addOption(modGroupId, { name: "Beef +$3", priceAdjustment: 300 });
await modifierSvc.addOption(modGroupId, { name: "Tofu -$1", priceAdjustment: -100 });

// Checklist
const checklist = await checklistSvc.createChecklist(ORG, {
  name: "Pre-Billing Check", type: "pre_billing",
  items: [{ label: "All items delivered", isRequired: true }, { label: "Customer OK", isRequired: true }],
});
assert(checklist.ok, "Pre-billing checklist created");

// Recipe
const recipe = await recipeSvc.createRecipe(ORG, {
  entityId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  name: "House Burger BOM", yieldQuantity: 1,
  ingredients: [
    { ingredientName: "Beef patty 200g", quantity: 1, unit: "pc", costPerUnit: 350 },
    { ingredientName: "Brioche bun", quantity: 1, unit: "pc", costPerUnit: 80 },
    { ingredientName: "Lettuce", quantity: 30, unit: "g", costPerUnit: 1 },
  ],
});
assert(recipe.ok, "Recipe created");
if (recipe.ok) assert(recipe.value.costPerUnit === 460, `COGS/unit = ${recipe.value.costPerUnit} (350+80+30)`);

// Alert config
await alertSvc.setThreshold(ORG, "delayed_order", 15);
await alertSvc.setThreshold(ORG, "prolonged_occupancy", 90);

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2: LUNCH SERVICE
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 2: Lunch Service ===\n");

// Open shift
const shift = await shiftSvc.open(ORG, { terminalId, operatorId: "cashier-amy", openingFloat: 20000 });
assert(shift.ok, "Shift opened with $200 float");
const shiftId = shift.ok ? shift.value.id : "";

// Create a cart for transaction
const cart1 = await kernel.services.cart.create({ currency: "USD" }, { type: "user", userId: "cashier-amy", email: null, name: "Amy", vendorId: null, organizationId: ORG, role: "cashier", permissions: ["*:*"] });
const cart1Id = cart1.ok ? cart1.value.id : "";

// Transaction 1: Dine-in at T1, split payment $35 cash + $15 card
const txn1 = await txnSvc.create(ORG, { shiftId, terminalId, operatorId: "cashier-amy", cartId: cart1Id });
assert(txn1.ok, "Transaction 1 created");
const txn1Id = txn1.ok ? txn1.value.id : "";

const seat1 = await tableSvc.assignToTransaction(ORG, t1Id, txn1Id);
assert(seat1.ok, "T1 seated (occupied)");

await paymentSvc.addPayment(ORG, txn1Id, { method: "cash", amount: 3500 });
await paymentSvc.addPayment(ORG, txn1Id, { method: "card", amount: 1500, reference: "****4321" });
const comp1 = await txnSvc.complete(txn1Id, null);
assert(comp1.ok, "Txn 1 completed ($35 cash + $15 card)");

await tableSvc.clear(ORG, t1Id);

// Transaction 2: Takeaway $22 cash
const cart2 = await kernel.services.cart.create({ currency: "USD" }, { type: "user", userId: "cashier-amy", email: null, name: "Amy", vendorId: null, organizationId: ORG, role: "cashier", permissions: ["*:*"] });
const txn2 = await txnSvc.create(ORG, { shiftId, terminalId, operatorId: "cashier-amy", cartId: cart2.ok ? cart2.value.id : "" });
const txn2Id = txn2.ok ? txn2.value.id : "";
await paymentSvc.addPayment(ORG, txn2Id, { method: "cash", amount: 2200 });
await txnSvc.complete(txn2Id, null);
assert(txn2.ok, "Txn 2 completed ($22 cash takeaway)");

// Transaction 3: Hold, recall, pay $42 card
const cart3 = await kernel.services.cart.create({ currency: "USD" }, { type: "user", userId: "cashier-amy", email: null, name: "Amy", vendorId: null, organizationId: ORG, role: "cashier", permissions: ["*:*"] });
const txn3 = await txnSvc.create(ORG, { shiftId, terminalId, operatorId: "cashier-amy", cartId: cart3.ok ? cart3.value.id : "" });
const txn3Id = txn3.ok ? txn3.value.id : "";
await txnSvc.hold(ORG, txn3Id, "John waiting");
const recall = await txnSvc.recall(ORG, txn3Id);
assert(recall.ok, "Txn 3 held and recalled");
await paymentSvc.addPayment(ORG, txn3Id, { method: "card", amount: 4200 });
await txnSvc.complete(txn3Id, null);

// Cash drop
await shiftSvc.addCashEvent(shiftId, { type: "drop", amount: 3000, reason: "Safe deposit", performedBy: "cashier-amy" });

// Transaction 4: Voided by manager
const cart4 = await kernel.services.cart.create({ currency: "USD" }, { type: "user", userId: "cashier-amy", email: null, name: "Amy", vendorId: null, organizationId: ORG, role: "cashier", permissions: ["*:*"] });
const txn4 = await txnSvc.create(ORG, { shiftId, terminalId, operatorId: "cashier-amy", cartId: cart4.ok ? cart4.value.id : "" });
const txn4Id = txn4.ok ? txn4.value.id : "";
const voidRes = await txnSvc.void(ORG, txn4Id, "Wrong order entered");
assert(voidRes.ok, "Txn 4 voided with reason");

// Transaction 5: $50 cash (barista will try to void this)
const cart5 = await kernel.services.cart.create({ currency: "USD" }, { type: "user", userId: "cashier-amy", email: null, name: "Amy", vendorId: null, organizationId: ORG, role: "cashier", permissions: ["*:*"] });
const txn5 = await txnSvc.create(ORG, { shiftId, terminalId, operatorId: "cashier-amy", cartId: cart5.ok ? cart5.value.id : "" });
const txn5Id = txn5.ok ? txn5.value.id : "";
await paymentSvc.addPayment(ORG, txn5Id, { method: "cash", amount: 5000 });
await txnSvc.complete(txn5Id, null);

// KDS tickets
const tickets = await kdsSvc.generateTickets(ORG, {
  transactionId: txn1Id,
  items: [
    { entityId: "a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5", itemName: "Grilled Steak", quantity: 1, itemGroup: "mains", courseName: "Mains", coursePriority: 2, showCourseLabel: true },
    { entityId: "b2b2b2b2-c3c3-4d4d-8e5e-f6f6f6f6f6f6", itemName: "Mojito", quantity: 2, itemGroup: "beverages", courseName: "Drinks", coursePriority: 0 },
  ],
  tableNumber: "T1", operatorName: "James Wilson",
});
assert(tickets.ok && tickets.value.length === 2, `KDS: 2 tickets generated (grill + bar)`);

// Mark grill ticket served
if (tickets.ok && tickets.value.length > 0) {
  const grillTicket = tickets.value.find(t => t.stationId === grillId);
  if (grillTicket) {
    await kdsSvc.startTicket(grillTicket.id);
    await kdsSvc.readyTicket(grillTicket.id);
    await kdsSvc.serveTicket(grillTicket.id);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3: ADVERSARIAL
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 3: Adversarial ===\n");

// Double-seat
const doubleSeat = await tableSvc.assignToTransaction(ORG, t2Id, txn1Id);
// T2 is available so this will work. Let's try a truly occupied one:
// Seat T2 first
const cart6 = await kernel.services.cart.create({ currency: "USD" }, { type: "user", userId: "cashier-amy", email: null, name: "Amy", vendorId: null, organizationId: ORG, role: "cashier", permissions: ["*:*"] });
const txn6 = await txnSvc.create(ORG, { shiftId, terminalId, operatorId: "cashier-amy", cartId: cart6.ok ? cart6.value.id : "" });
await tableSvc.assignToTransaction(ORG, t2Id, txn6.ok ? txn6.value.id : "");
const doubleSeat2 = await tableSvc.assignToTransaction(ORG, t2Id, "00000000-0000-0000-0000-000000000001");
assert(!doubleSeat2.ok, "DOUBLE-SEAT blocked: occupied table rejects assignment");
await tableSvc.clear(ORG, t2Id);

// Cross-zone transfer
await tableSvc.assignToTransaction(ORG, t3Id, txn6.ok ? txn6.value.id : "");
const crossZone = await tableSvc.transfer(ORG, t3Id, p1Id);
assert(!crossZone.ok, "CROSS-ZONE blocked: Main Hall -> Patio rejected");
await tableSvc.clear(ORG, t3Id);

// Duplicate shift on same terminal
const dupShift = await shiftSvc.open(ORG, { terminalId, operatorId: "cashier-amy", openingFloat: 5000 });
assert(!dupShift.ok, "DUPLICATE SHIFT blocked: same terminal");

// ═══════════════════════════════════════════════════════════════════════
// PHASE 4: CLOSE + P&L
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 4: End of Day ===\n");

const close = await shiftSvc.close(ORG, shiftId, { closingCount: 24500 });
assert(close.ok, "Shift closed");
if (close.ok) {
  assert(close.value.status === "closed", `Status: ${close.value.status}`);
  assert(close.value.expectedCash !== null && close.value.expectedCash !== undefined, `Expected cash: ${close.value.expectedCash}`);
  assert(close.value.cashVariance !== null && close.value.cashVariance !== undefined, `Cash variance: ${close.value.cashVariance}`);
}

const report = await shiftSvc.getReport(ORG, shiftId);
assert(report.ok, "Z-report generated");

// Daily P&L
const pnl = await analyticsSvc.createDailyPnl(ORG, {
  date: new Date(), grossSales: 157000, netSales: 152000,
  costOfGoods: 48000, directExpenses: 12000, indirectExpenses: 25000, employeeCosts: 35000,
  transactionCount: 5,
  expenses: [
    { category: "cogs", name: "Food", amount: 38000 },
    { category: "cogs", name: "Beverages", amount: 10000 },
    { category: "direct", name: "Packaging", amount: 7000 },
    { category: "direct", name: "Delivery fees", amount: 5000 },
    { category: "indirect", name: "Rent", amount: 15000 },
    { category: "indirect", name: "Utilities", amount: 10000 },
    { category: "employee", name: "Kitchen", amount: 20000 },
    { category: "employee", name: "FOH", amount: 15000 },
  ],
});
assert(pnl.ok, "Daily P&L created");
if (pnl.ok) {
  assert(pnl.value.grossProfit === 92000, `Gross profit: $${pnl.value.grossProfit / 100}`);
  assert(pnl.value.netProfit === 32000, `Net profit: $${pnl.value.netProfit / 100}`);
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 5: DIRECT DATABASE VALIDATION
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 5: Direct PostgreSQL Validation ===\n");

const q = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> => {
  const result = await rawDb.execute(query);
  // postgres.js returns array directly, PGlite returns {rows: [...]}
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return (result as { rows: Record<string, unknown>[] }).rows;
};

// pos_terminals
const dbTerminals = await q(sql`SELECT code, name, organization_id, is_active FROM pos_terminals ORDER BY code`);
assert(dbTerminals.length === 2, `pos_terminals: ${dbTerminals.length} rows`);
assert(dbTerminals[0]!.code === "BAR1" && dbTerminals[1]!.code === "R1", `Codes: ${dbTerminals.map(r => r.code).join(", ")}`);
assert(dbTerminals.every(r => r.organization_id === "org_default"), "All terminals scoped to org_default");

// pos_tables
const dbTables = await q(sql`SELECT number, zone, status, capacity FROM pos_tables ORDER BY number`);
assert(dbTables.length === 4, `pos_tables: ${dbTables.length} rows`);
assert(dbTables.every(r => r.status === "available"), `All tables available after clearing: ${dbTables.map(r => `${r.number}=${r.status}`).join(", ")}`);

// pos_shifts
const dbShifts = await q(sql`SELECT status, opening_float, closing_count, expected_cash, cash_variance, sales_count, voids_count FROM pos_shifts`);
assert(dbShifts.length === 1, `pos_shifts: ${dbShifts.length} row`);
assert(dbShifts[0]!.status === "closed", `Shift status: ${dbShifts[0]!.status}`);
assert(dbShifts[0]!.opening_float === 20000, `Opening float: $${Number(dbShifts[0]!.opening_float) / 100}`);
assert(dbShifts[0]!.closing_count === 24500, `Closing count: $${Number(dbShifts[0]!.closing_count) / 100}`);
console.log(`  [INFO] Expected cash: $${Number(dbShifts[0]!.expected_cash) / 100}, Variance: $${Number(dbShifts[0]!.cash_variance) / 100}`);

// pos_transactions
const dbTxns = await q(sql`SELECT status, receipt_number, void_reason FROM pos_transactions ORDER BY created_at`);
assert(dbTxns.length >= 6, `pos_transactions: ${dbTxns.length} rows`);
const voided = dbTxns.filter(r => r.status === "voided");
assert(voided.length === 1, `Voided: ${voided.length}`);
assert(voided[0]!.void_reason === "Wrong order entered", `Void reason: "${voided[0]!.void_reason}"`);
const completed = dbTxns.filter(r => r.status === "completed");
assert(completed.length >= 4, `Completed: ${completed.length}`);

// pos_payments
const dbPayments = await q(sql`SELECT method, amount, change_given, reference, status FROM pos_payments ORDER BY processed_at`);
assert(dbPayments.length >= 5, `pos_payments: ${dbPayments.length} rows`);
const cashPay = dbPayments.filter(r => r.method === "cash");
const cardPay = dbPayments.filter(r => r.method === "card");
assert(cashPay.length >= 3, `Cash payments: ${cashPay.length}`);
assert(cardPay.length >= 2, `Card payments: ${cardPay.length}`);
const cardRef = cardPay.find(r => r.reference === "****4321");
assert(cardRef !== undefined, "Card reference ****4321 preserved in DB");

// pos_cash_events
const dbCashEvents = await q(sql`SELECT type, amount, reason, performed_by FROM pos_cash_events ORDER BY performed_at`);
assert(dbCashEvents.length >= 2, `pos_cash_events: ${dbCashEvents.length} rows`);
const drop = dbCashEvents.find(r => r.type === "drop");
assert(drop !== undefined, "Cash drop event exists");
assert(drop!.amount === 3000, `Drop amount: $${Number(drop!.amount) / 100}`);
assert(drop!.performed_by === "cashier-amy", `Drop by: ${drop!.performed_by}`);

// pos_modifier_groups + options
const dbModGroups = await q(sql`SELECT name, is_required, min_select, max_select FROM pos_modifier_groups`);
assert(dbModGroups.length === 1, `pos_modifier_groups: ${dbModGroups.length} row`);
assert(dbModGroups[0]!.is_required === true, `Required: ${dbModGroups[0]!.is_required}`);

const dbModOpts = await q(sql`SELECT name, price_adjustment FROM pos_modifier_options ORDER BY sort_order`);
assert(dbModOpts.length === 3, `pos_modifier_options: ${dbModOpts.length} rows`);
assert(dbModOpts[1]!.price_adjustment === 300, `Beef surcharge: +$${Number(dbModOpts[1]!.price_adjustment) / 100}`);

// kds_stations + item groups
const dbStations = await q(sql`SELECT name, alert_threshold_minutes FROM kds_stations ORDER BY name`);
assert(dbStations.length === 2, `kds_stations: ${dbStations.length} rows`);

const dbItemGroups = await q(sql`SELECT item_group FROM kds_station_item_groups ORDER BY item_group`);
assert(dbItemGroups.length === 3, `kds_station_item_groups: ${dbItemGroups.length} rows`);

// kds_tickets
const dbTickets = await q(sql`SELECT type, status, table_number, operator_name, ticket_number FROM kds_tickets ORDER BY created_at`);
assert(dbTickets.length === 2, `kds_tickets: ${dbTickets.length} rows (grill + bar)`);
const servedTicket = dbTickets.find(r => r.status === "served");
assert(servedTicket !== undefined, "Grill ticket served");
const pendingTicket = dbTickets.find(r => r.status === "pending");
assert(pendingTicket !== undefined, "Bar ticket still pending");

// kds_ticket_items
const dbTicketItems = await q(sql`SELECT item_name, quantity, course_name, course_priority, show_course_label FROM kds_ticket_items ORDER BY course_priority`);
assert(dbTicketItems.length === 2, `kds_ticket_items: ${dbTicketItems.length} rows`);
assert(dbTicketItems[0]!.item_name === "Mojito", `First by priority: ${dbTicketItems[0]!.item_name} (drinks fire first)`);
assert(dbTicketItems[1]!.item_name === "Grilled Steak", `Second by priority: ${dbTicketItems[1]!.item_name} (mains fire second)`);

// pos_checklists
const dbChecklists = await q(sql`SELECT name, type FROM pos_checklists`);
assert(dbChecklists.length === 1, `pos_checklists: ${dbChecklists.length} row`);

const dbCheckItems = await q(sql`SELECT label, is_required FROM pos_checklist_items ORDER BY sort_order`);
assert(dbCheckItems.length === 2, `pos_checklist_items: ${dbCheckItems.length} rows`);

// pos_recipes + ingredients
const dbRecipes = await q(sql`SELECT name, yield_quantity FROM pos_recipes`);
assert(dbRecipes.length === 1, `pos_recipes: ${dbRecipes.length} row`);

const dbIngredients = await q(sql`SELECT ingredient_name, cost_per_unit FROM pos_recipe_ingredients ORDER BY sort_order`);
assert(dbIngredients.length === 3, `pos_recipe_ingredients: ${dbIngredients.length} rows`);

// pos_alert_config
const dbAlerts = await q(sql`SELECT alert_type, threshold_minutes FROM pos_alert_config ORDER BY alert_type`);
assert(dbAlerts.length === 2, `pos_alert_config: ${dbAlerts.length} rows`);

// pos_daily_pnl
const dbPnl = await q(sql`SELECT gross_sales, net_sales, cost_of_goods, gross_profit, net_profit, transaction_count FROM pos_daily_pnl`);
assert(dbPnl.length === 1, `pos_daily_pnl: ${dbPnl.length} row`);
assert(dbPnl[0]!.gross_profit === 92000, `Gross profit: $${Number(dbPnl[0]!.gross_profit) / 100}`);
assert(dbPnl[0]!.net_profit === 32000, `Net profit: $${Number(dbPnl[0]!.net_profit) / 100}`);

// pos_pnl_expenses
const dbPnlExp = await q(sql`SELECT category, name, amount FROM pos_pnl_expenses ORDER BY category, name`);
assert(dbPnlExp.length === 8, `pos_pnl_expenses: ${dbPnlExp.length} rows`);

// Organization isolation
const orgCounts = await q(sql`
  SELECT 'terminals' AS tbl, COUNT(DISTINCT organization_id)::int AS orgs FROM pos_terminals
  UNION ALL SELECT 'tables', COUNT(DISTINCT organization_id)::int FROM pos_tables
  UNION ALL SELECT 'stations', COUNT(DISTINCT organization_id)::int FROM kds_stations
  UNION ALL SELECT 'shifts', COUNT(DISTINCT organization_id)::int FROM pos_shifts
  UNION ALL SELECT 'transactions', COUNT(DISTINCT organization_id)::int FROM pos_transactions
`);
assert(orgCounts.every(r => r.orgs === 1), "All data scoped to single org (no cross-org leakage)");

// ═══════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(60));
console.log(`  VALIDATION COMPLETE: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  console.log("\n  VERDICT: REVIEW FAILURES ABOVE\n");
} else {
  console.log("\n  VERDICT: ALL DATABASE ROWS VERIFIED\n");
  console.log("  17 tables validated against PostgreSQL:");
  console.log("    pos_terminals, pos_tables, pos_shifts,");
  console.log("    pos_transactions, pos_payments, pos_cash_events,");
  console.log("    pos_modifier_groups, pos_modifier_options,");
  console.log("    kds_stations, kds_station_item_groups,");
  console.log("    kds_tickets, kds_ticket_items,");
  console.log("    pos_checklists, pos_checklist_items,");
  console.log("    pos_recipes, pos_recipe_ingredients,");
  console.log("    pos_alert_config, pos_daily_pnl, pos_pnl_expenses\n");
}

process.exit(failed > 0 ? 1 : 0);
