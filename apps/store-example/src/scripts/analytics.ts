/**
 * Demo: Analytics queries — revenue, order counts, inventory value.
 *
 * This script uses the kernel directly (not HTTP) since the analytics
 * API is exposed through MCP tools, not REST routes.
 *
 * Run: bun run demo:analytics
 */

import { createKernel } from "@porulle/core";
import configPromise from "../../commerce.config.js";

const config = await configPromise;
const kernel = createKernel(config);

function log(label: string, data: unknown) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log("  ANALYTICS DASHBOARD");
  console.log(`${"═".repeat(60)}`);

  // ─── Revenue summary ─────────────────────────────────────────────
  const adminScope = { role: "admin" as const };

  const revenue = await kernel.services.analytics.query({
    measures: ["Orders.revenue", "Orders.count", "Orders.averageOrderValue"],
  }, adminScope);
  if (revenue.ok) {
    log("Revenue Summary", revenue.value.rows);
  }

  // ─── Orders by status ────────────────────────────────────────────
  const byStatus = await kernel.services.analytics.query({
    measures: ["Orders.count"],
    dimensions: ["Orders.status"],
    order: { "Orders.count": "desc" },
  }, adminScope);
  if (byStatus.ok) {
    log("Orders by Status", byStatus.value.rows);
  }

  // ─── Top selling items ───────────────────────────────────────────
  const topItems = await kernel.services.analytics.query({
    measures: ["OrderLineItems.itemsSold", "OrderLineItems.lineItemRevenue"],
    dimensions: ["OrderLineItems.title"],
    order: { "OrderLineItems.itemsSold": "desc" },
    limit: 5,
  }, adminScope);
  if (topItems.ok) {
    log("Top Selling Items", topItems.value.rows);
  }

  // ─── Inventory value by warehouse ────────────────────────────────
  const inventoryValue = await kernel.services.analytics.query({
    measures: ["Inventory.inventoryValue", "Inventory.totalOnHand"],
    dimensions: ["Inventory.warehouseId"],
  }, adminScope);
  if (inventoryValue.ok) {
    log("Inventory Value by Warehouse", inventoryValue.value.rows);
  }

  // ─── Low stock alerts ────────────────────────────────────────────
  const lowStock = await kernel.services.analytics.query({
    measures: ["Inventory.lowStockCount", "Inventory.totalAvailable"],
    dimensions: ["Inventory.entityId"],
  }, adminScope);
  if (lowStock.ok) {
    log("Stock Levels by Entity", lowStock.value.rows);
  }

  // ─── Available analytics models ──────────────────────────────────
  const meta = await kernel.services.analytics.getMeta();
  if (meta.ok) {
    log("Available Analytics Models", {
      models: meta.value.models.map((m: { name: string }) => m.name),
      measures: meta.value.measures,
      dimensions: meta.value.dimensions,
    });
  }

  console.log("\n✅ Analytics complete.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Analytics failed:", err);
  process.exit(1);
});
