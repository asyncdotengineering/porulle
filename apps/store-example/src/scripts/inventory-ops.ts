/**
 * Demo: Inventory operations — check stock, adjust levels, view warehouses.
 *
 * Run: bun run demo:inventory  (server must be running)
 */

import { api, log, heading } from "./_helpers.js";

async function main() {
  heading("INVENTORY OPERATIONS");

  // ─── List products to check stock ────────────────────────────────
  const catalog = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/catalog/entities?type=product",
  );

  // ─── Check stock for all products ────────────────────────────────
  const entityIds = catalog.data.map((p: Record<string, any>) => p.id).join(",");
  const stockCheck = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/inventory/check?entityIds=${entityIds}`,
  );
  log(
    "Stock Levels (all products)",
    catalog.data.map((p: Record<string, any>) => ({
      slug: p.slug,
      available: stockCheck.data?.[p.id] ?? "unknown",
    })),
  );

  // ─── List warehouses ─────────────────────────────────────────────
  const warehouses = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/inventory/warehouses",
  );
  log("Warehouses", warehouses.data);

  // ─── Adjust inventory (simulate receiving new shipment) ──────────
  const tee = catalog.data.find((p: Record<string, any>) => p.slug === "classic-tee");
  if (tee && warehouses.data.length > 0) {
    const wh = warehouses.data[0]!;
    const adjustment = await api<{ data: Record<string, any> }>(
      "POST",
      "/api/inventory/adjust",
      {
        entityId: tee.id,
        warehouseId: wh.id,
        adjustment: 25,
        reason: "shipment_received",
      },
    );
    log("Inventory Adjusted (+25 Classic Tee to Main)", adjustment.data);

    // Re-check stock
    const recheck = await api<{ data: Record<string, any> }>(
      "GET",
      `/api/inventory/check?entityIds=${tee.id}`,
    );
    log("Updated Stock (Classic Tee)", {
      available: recheck.data?.[tee.id] ?? "unknown",
    });
  }

  console.log("\n✅ Inventory operations complete.\n");
}

main().catch(console.error);
