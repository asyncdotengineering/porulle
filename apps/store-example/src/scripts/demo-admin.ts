/**
 * Demo: Admin / Staff operations — catalog, inventory, promotions, order management.
 *
 * Run: bun run demo:admin  (server must be running, seed must have been run)
 */

import { api, log, heading } from "./_helpers.js";

async function main() {
  // ─── 1. Catalog overview ─────────────────────────────────────────
  heading("1 · CATALOG OVERVIEW (with inventory)");

  const catalog = await api<{ data: Record<string, any>[]; meta: Record<string, any> }>(
    "GET",
    "/api/catalog/entities?type=product&include=attributes,inventory",
  );
  log("All products", catalog.data.map((p: Record<string, any>) => ({
    id: p.id,
    slug: p.slug,
    title: p.attributes?.[0]?.title ?? p.slug,
    status: p.status,
    inventory: p.inventory,
  })));

  // ─── 2. Inventory — all warehouses and stock levels ──────────────
  heading("2 · WAREHOUSES & INVENTORY LEVELS");

  const warehouses = await api<{ data: Record<string, any>[] }>("GET", "/api/inventory/warehouses");
  log("Warehouses", warehouses.data.map((w: Record<string, any>) => ({
    id: w.id,
    code: w.code,
    name: w.name,
    priority: w.priority,
  })));

  // Check available stock for each product
  const entityIds = catalog.data.map((p: Record<string, any>) => p.id).join(",");
  const stock = await api<{ data: Record<string, number> }>(
    "GET",
    `/api/inventory/check?entityIds=${entityIds}`,
  );
  log("Available stock per product", Object.fromEntries(
    catalog.data.map((p: Record<string, any>) => [
      p.attributes?.[0]?.title ?? p.slug,
      stock.data[p.id] ?? 0,
    ]),
  ));

  // ─── 3. Restock Knit Beanie at both warehouses ───────────────────
  heading("3 · INVENTORY RESTOCK");

  const beanie = catalog.data.find((p: Record<string, any>) => p.slug === "beanie-knit");
  const mainWh = warehouses.data.find((w: Record<string, any>) => w.code === "MAIN");
  const popupWh = warehouses.data.find((w: Record<string, any>) => w.code === "POPUP");

  if (beanie && mainWh) {
    const restock = await api<{ data: Record<string, any> }>("POST", "/api/inventory/adjust", {
      entityId: beanie.id,
      warehouseId: mainWh.id,
      adjustment: 100,
      reason: "quarterly_restock",
    });
    log("Restocked Knit Beanie (MAIN +100)", {
      entityId: beanie.id,
      quantityOnHand: restock.data.quantityOnHand,
      warehouse: "MAIN",
    });
  }

  if (beanie && popupWh) {
    const restockPopup = await api<{ data: Record<string, any> }>("POST", "/api/inventory/adjust", {
      entityId: beanie.id,
      warehouseId: popupWh.id,
      adjustment: 30,
      reason: "quarterly_restock",
    });
    log("Restocked Knit Beanie (POPUP +30)", {
      quantityOnHand: restockPopup.data.quantityOnHand,
      warehouse: "POPUP",
    });
  }

  // ─── 4. Create a flash sale promotion ────────────────────────────
  heading("4 · CREATE FLASH SALE PROMOTION");

  const flashCode = `FLASH20-${Date.now()}`;
  const flashSale = await api<{ data: Record<string, any> }>("POST", "/api/promotions", {
    name: flashCode,
    code: flashCode,
    type: "percentage_off_order",
    value: 20,
    isActive: true,
    minimumOrderAmount: 5000,
    validFrom: new Date().toISOString(),
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
  });
  log("Flash Sale Created", {
    code: flashSale.data.code,
    discount: `${flashSale.data.value}% off`,
    minimumOrder: `$${((flashSale.data.minimumOrderAmount ?? 0) / 100).toFixed(2)}`,
    validUntil: flashSale.data.validUntil,
  });

  // ─── 5. List all active promotions ───────────────────────────────
  heading("5 · ACTIVE PROMOTIONS");

  const promos = await api<{ data: Record<string, any>[] }>("GET", "/api/promotions");
  log("Active promotions", promos.data.map((p: Record<string, any>) => ({
    code: p.code,
    type: p.type,
    value: p.value,
    usageCount: p.usageCount ?? 0,
  })));

  // ─── 6. All orders — list and inspect ────────────────────────────
  heading("6 · ORDER MANAGEMENT");

  const orders = await api<{ data: Record<string, any>[]; meta: Record<string, any> }>("GET", "/api/orders");
  log("All orders", orders.data.map((o: Record<string, any>) => ({
    orderNumber: o.orderNumber,
    status: o.status,
    grandTotal: `$${(o.grandTotal / 100).toFixed(2)}`,
    currency: o.currency,
    placedAt: o.placedAt,
  })));

  // Inspect the most recent order in detail
  const latestOrder = orders.data[orders.data.length - 1];
  if (latestOrder) {
    const detail = await api<{ data: Record<string, any> }>(
      "GET",
      `/api/orders/${latestOrder.id}`,
    );
    log(`Order Detail — ${detail.data.orderNumber}`, {
      status: detail.data.status,
      grandTotal: `$${(detail.data.grandTotal / 100).toFixed(2)}`,
      lineItems: detail.data.lineItems?.map((li: Record<string, any>) => ({
        title: li.title,
        qty: li.quantity,
        price: `$${(li.unitPrice / 100).toFixed(2)}`,
      })),
      fulfillmentStatus: detail.data.lineItems?.map((li: Record<string, any>) => li.fulfillmentStatus),
    });

    // Check fulfillment records
    const fulfillments = await api<{ data: Record<string, any>[] }>(
      "GET",
      `/api/orders/${latestOrder.id}/fulfillments`,
    );
    log("Fulfillment records", fulfillments.data.map((f: Record<string, any>) => ({
      id: f.id,
      status: f.status,
      carrier: f.carrier,
      trackingNumber: f.trackingNumber,
    })));
  }

  // ─── 7. Status progression: pending → confirmed → processing → fulfilled ───
  heading("7 · ORDER STATUS PROGRESSION");

  // Find a pending order to progress; fall back to confirmed if none pending
  const pendingOrders = orders.data.filter((o: Record<string, any>) => o.status === "pending");
  const confirmedOrders = orders.data.filter((o: Record<string, any>) => o.status === "confirmed");
  const orderToProgress = pendingOrders[0] ?? confirmedOrders[0] ?? orders.data[0];

  if (orderToProgress) {
    let currentStatus = orderToProgress.status;

    // Confirm if pending
    if (currentStatus === "pending") {
      const confirmed = await api<{ data: Record<string, any> }>(
        "PATCH",
        `/api/orders/${orderToProgress.id}/status`,
        { status: "confirmed" },
      );
      log(`Confirmed order ${confirmed.data.orderNumber}`, { status: confirmed.data.status });
      currentStatus = confirmed.data.status;
    }

    // Move to processing
    if (currentStatus === "confirmed") {
      const processing = await api<{ data: Record<string, any> }>(
        "PATCH",
        `/api/orders/${orderToProgress.id}/status`,
        { status: "processing", reason: "Dispatched from MAIN warehouse" },
      );
      log(`Processing order ${processing.data.orderNumber}`, { status: processing.data.status });
      currentStatus = processing.data.status;
    }

    // Fulfill
    if (currentStatus === "processing") {
      const fulfilled = await api<{ data: Record<string, any> }>(
        "PATCH",
        `/api/orders/${orderToProgress.id}/status`,
        { status: "fulfilled" },
      );
      log(`Fulfilled order ${fulfilled.data.orderNumber}`, { status: fulfilled.data.status });
    }
  }

  // ─── 8. Search catalog ───────────────────────────────────────────
  heading("8 · CATALOG SEARCH");

  const searchResults = await api<{ data: Record<string, any>[]; meta: Record<string, any> }>(
    "GET",
    "/api/search?q=hoodie",
  );
  log("Search: 'hoodie'", {
    total: searchResults.meta?.total,
    hits: searchResults.data.map((h: Record<string, any>) => ({ title: h.title, score: h.score })),
  });

  const suggest = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/search/suggest?prefix=knit",
  );
  log("Suggest: 'knit'", suggest.data);

  // ─── 9. Final inventory snapshot ─────────────────────────────────
  heading("9 · FINAL INVENTORY SNAPSHOT");

  const finalStock = await api<{ data: Record<string, number> }>(
    "GET",
    `/api/inventory/check?entityIds=${entityIds}`,
  );
  log("Stock after restock + order reservations", Object.fromEntries(
    catalog.data.map((p: Record<string, any>) => [
      p.attributes?.[0]?.title ?? p.slug,
      finalStock.data[p.id] ?? 0,
    ]),
  ));

  console.log("\n✅ Admin demo complete.\n");
}

main().catch(console.error);
