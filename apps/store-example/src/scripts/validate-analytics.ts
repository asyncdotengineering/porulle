/**
 * Analytics Validation — cross-checks DrizzleAnalyticsAdapter against raw SQL.
 *
 * Runs after generate:year to verify that the SQL-based analytics adapter
 * produces correct results over a large, realistic dataset.
 *
 * Run: bun run analytics:validate
 * Prerequisite: bun run generate:year (or any dataset in the DB)
 */

import { createKernel, buildAnalyticsScope } from "@porulle/core";
import configPromise from "../../commerce.config.js";
import { sql } from "@porulle/core/drizzle";

const ADMIN_SCOPE = buildAnalyticsScope({ role: "admin" });

const config = await configPromise;
const kernel = createKernel(config);
const db = (kernel.database as { db: { execute(q: unknown): Promise<unknown> } }).db;

type Row = Record<string, unknown>;

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = typeof actual === "bigint" ? Number(actual) : actual;
  const e = typeof expected === "bigint" ? Number(expected) : expected;
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}: ${a}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}: got ${a}, expected ${e}`);
  }
}

function checkGte(label: string, actual: number, minimum: number) {
  if (actual >= minimum) {
    passed++;
    console.log(`  ✓ ${label}: ${actual} (>= ${minimum})`);
  } else {
    failed++;
    console.log(`  ✗ ${label}: ${actual} (expected >= ${minimum})`);
  }
}

async function main() {
  console.log("\n📊 ANALYTICS VALIDATION");
  console.log("═".repeat(60));

  // ─── 1. Total Order Count ──────────────────────────────────────────

  console.log("\n1. TOTAL ORDER COUNT");

  const analyticsTotal = await kernel.services.analytics.query({
    measures: ["Orders.count", "Orders.revenue"],
  }, ADMIN_SCOPE);
  const rawTotal = await db.execute(sql`SELECT COUNT(*) AS count, SUM(grand_total) AS revenue FROM orders`) as Row[];
  const rawRow = (rawTotal as unknown as { rows: Row[] }).rows?.[0] ?? rawTotal[0] ?? {};

  const analyticsCount = Number((analyticsTotal as { ok: true; value: { rows: Row[] } }).value.rows[0]?.["Orders.count"] ?? 0);
  const analyticsRevenue = Number((analyticsTotal as { ok: true; value: { rows: Row[] } }).value.rows[0]?.["Orders.revenue"] ?? 0);
  const rawCount = Number(rawRow.count ?? 0);
  const rawRevenue = Number(rawRow.revenue ?? 0);

  check("Order count", analyticsCount, rawCount);
  check("Total revenue", analyticsRevenue, rawRevenue);
  checkGte("Has significant data", rawCount, 100);

  // ─── 2. Revenue by Status ──────────────────────────────────────────

  console.log("\n2. REVENUE BY STATUS");

  const analyticsByStatus = await kernel.services.analytics.query({
    measures: ["Orders.revenue", "Orders.count"],
    dimensions: ["Orders.status"],
  }, ADMIN_SCOPE);
  const rawByStatus = await db.execute(
    sql`SELECT status, SUM(grand_total) AS revenue, COUNT(*) AS count FROM orders GROUP BY status ORDER BY status`,
  ) as Row[];
  const rawStatusRows = (rawByStatus as unknown as { rows: Row[] }).rows ?? rawByStatus as unknown as Row[];

  const analyticsStatusRows = (analyticsByStatus as { ok: true; value: { rows: Row[] } }).value.rows;

  // Sum of per-status revenues should equal total
  const sumStatusRevenue = analyticsStatusRows.reduce(
    (sum: number, r: Row) => sum + Number(r["Orders.revenue"] ?? 0), 0,
  );
  check("Sum of status revenues = total", sumStatusRevenue, analyticsRevenue);

  // Check specific statuses exist
  const statuses = analyticsStatusRows.map((r: Row) => r["Orders.status"]);
  checkGte("Distinct statuses", statuses.length, 3);

  // ─── 3. Monthly Revenue (Time Dimension) ───────────────────────────

  console.log("\n3. MONTHLY REVENUE");

  const analyticsByMonth = await kernel.services.analytics.query({
    measures: ["Orders.revenue", "Orders.count"],
    timeDimensions: [{
      dimension: "Orders.placedAt",
      granularity: "month",
      dateRange: ["2025-07-01", "2026-07-01"],
    }],
    order: { "Orders.placedAt": "asc" },
  }, ADMIN_SCOPE);
  const rawByMonth = await db.execute(
    sql`SELECT TO_CHAR(DATE_TRUNC('month', placed_at), 'YYYY-MM') AS month,
               SUM(grand_total) AS revenue, COUNT(*) AS count
        FROM orders
        WHERE placed_at >= '2025-07-01'::timestamptz AND placed_at < '2026-07-01'::timestamptz
        GROUP BY DATE_TRUNC('month', placed_at)
        ORDER BY month`,
  ) as Row[];
  const rawMonthRows = (rawByMonth as unknown as { rows: Row[] }).rows ?? rawByMonth as unknown as Row[];

  const analyticsMonthRows = (analyticsByMonth as { ok: true; value: { rows: Row[] } }).value.rows;

  // Allow ±1 due to partial boundary months
  if (Math.abs(analyticsMonthRows.length - rawMonthRows.length) <= 1) {
    passed++;
    console.log(`  ✓ Month count: ${analyticsMonthRows.length} (raw: ${rawMonthRows.length})`);
  } else {
    failed++;
    console.log(`  ✗ Month count: got ${analyticsMonthRows.length}, expected ~${rawMonthRows.length}`);
  }

  // Verify November has the most orders (Black Friday)
  const novRow = analyticsMonthRows.find((r: Row) => r["Orders.placedAt"] === "2025-11");
  const febRow = analyticsMonthRows.find((r: Row) => r["Orders.placedAt"] === "2026-02");
  if (novRow && febRow) {
    const novOrders = Number(novRow["Orders.count"]);
    const febOrders = Number(febRow["Orders.count"]);
    if (novOrders > febOrders) {
      passed++;
      console.log(`  ✓ November (${novOrders}) > February (${febOrders}) — seasonal pattern correct`);
    } else {
      failed++;
      console.log(`  ✗ November (${novOrders}) should be > February (${febOrders})`);
    }
  }

  // Print monthly breakdown
  console.log("\n   Monthly breakdown:");
  for (const row of analyticsMonthRows) {
    const month = row["Orders.placedAt"] as string;
    const count = Number(row["Orders.count"]);
    const rev = Number(row["Orders.revenue"]);
    const bar = "█".repeat(Math.round(count / 20));
    console.log(`   ${month}  ${count.toString().padStart(5)} orders  $${(rev / 100).toFixed(0).padStart(8)}  ${bar}`);
  }

  // ─── 4. Top Products by Items Sold ─────────────────────────────────

  console.log("\n4. TOP PRODUCTS BY ITEMS SOLD");

  const analyticsTopProducts = await kernel.services.analytics.query({
    measures: ["OrderLineItems.itemsSold", "OrderLineItems.lineItemRevenue"],
    dimensions: ["OrderLineItems.title"],
    order: { "OrderLineItems.itemsSold": "desc" },
    limit: 10,
  }, ADMIN_SCOPE);
  const topRows = (analyticsTopProducts as { ok: true; value: { rows: Row[] } }).value.rows;

  checkGte("Products with sales", topRows.length, 3);
  for (const row of topRows.slice(0, 5)) {
    console.log(`   ${(row["OrderLineItems.title"] as string).padEnd(30)} ${String(row["OrderLineItems.itemsSold"]).padStart(5)} sold  $${(Number(row["OrderLineItems.lineItemRevenue"]) / 100).toFixed(0).padStart(7)}`);
  }

  // ─── 5. Inventory Health ───────────────────────────────────────────

  console.log("\n5. INVENTORY HEALTH");

  const analyticsInventory = await kernel.services.analytics.query({
    measures: ["Inventory.totalOnHand", "Inventory.totalAvailable", "Inventory.inventoryValue"],
  }, ADMIN_SCOPE);
  const invRow = (analyticsInventory as { ok: true; value: { rows: Row[] } }).value.rows[0] ?? {};

  const onHand = Number(invRow["Inventory.totalOnHand"] ?? 0);
  const available = Number(invRow["Inventory.totalAvailable"] ?? 0);
  const invValue = Number(invRow["Inventory.inventoryValue"] ?? 0);

  checkGte("Inventory on hand", onHand, 1);
  if (onHand >= available) {
    passed++;
    console.log(`  ✓ on_hand (${onHand}) >= available (${available})`);
  } else {
    failed++;
    console.log(`  ✗ on_hand (${onHand}) < available (${available})`);
  }
  console.log(`   Inventory value: $${(invValue / 100).toFixed(2)}`);

  // ─── 6. Meta Endpoint ──────────────────────────────────────────────

  console.log("\n6. META ENDPOINT");

  const meta = await kernel.services.analytics.getMeta();
  const metaValue = (meta as { ok: true; value: { models: { name: string }[]; measures: string[]; dimensions: string[] } }).value;
  checkGte("Models registered", metaValue.models.length, 4);
  checkGte("Measures available", metaValue.measures.length, 10);
  checkGte("Dimensions available", metaValue.dimensions.length, 10);

  // ─── Summary ───────────────────────────────────────────────────────

  console.log("\n" + "═".repeat(60));
  console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
  if (failed === 0) {
    console.log("  ✅ All analytics validations passed!\n");
  } else {
    console.log("  ❌ Some validations failed.\n");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Validation failed:", err);
  process.exit(1);
});
