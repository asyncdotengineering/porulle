/**
 * Demo: Create a cart, add items, and place an order via REST API.
 *
 * Run: bun run demo:cart  (server must be running)
 */

import { api, log, heading } from "./_helpers.js";

async function main() {
  heading("CART & CHECKOUT FLOW");

  // ─── Get products to add ─────────────────────────────────────────
  const catalog = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/catalog/entities?type=product",
  );
  if (catalog.data.length < 2) {
    console.error("Not enough products. Run 'bun run seed' first.");
    return;
  }

  const tee = catalog.data.find((p: Record<string, any>) => p.slug === "classic-tee");
  const hoodie = catalog.data.find((p: Record<string, any>) => p.slug === "oversized-hoodie");
  if (!tee || !hoodie) {
    console.error("Expected products not found. Run 'bun run seed' first.");
    return;
  }

  // ─── Create a cart ───────────────────────────────────────────────
  const cart = await api<{ data: Record<string, any> }>("POST", "/api/carts", {
    currency: "USD",
  });
  log("Cart Created", { id: cart.data.id, status: cart.data.status });

  // ─── Add items ───────────────────────────────────────────────────
  const addTee = await api<{ data: Record<string, any> }>(
    "POST",
    `/api/carts/${cart.data.id}/items`,
    {
      entityId: tee.id,
      quantity: 2,
      unitPriceSnapshot: tee.metadata?.basePrice ?? 2999,
    },
  );
  log("Added Classic Tee x2", { lineItemId: addTee.data.id });

  const addHoodie = await api<{ data: Record<string, any> }>(
    "POST",
    `/api/carts/${cart.data.id}/items`,
    {
      entityId: hoodie.id,
      quantity: 1,
      unitPriceSnapshot: hoodie.metadata?.basePrice ?? 7999,
    },
  );
  log("Added Oversized Hoodie x1", { lineItemId: addHoodie.data.id });

  // ─── View cart ───────────────────────────────────────────────────
  const cartDetail = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/carts/${cart.data.id}`,
  );
  log("Cart Contents", {
    id: cartDetail.data.id,
    currency: cartDetail.data.currency,
    lineItems: cartDetail.data.lineItems?.map((li: Record<string, any>) => ({
      entityId: li.entityId,
      quantity: li.quantity,
      unitPriceSnapshot: li.unitPriceSnapshot,
    })),
  });

  // ─── Checkout (creates order from cart) ──────────────────────────
  const checkout = await api<{ data: Record<string, any> }>("POST", "/api/checkout", {
    cartId: cart.data.id,
    paymentMethodId: "mock-payments",
    currency: "USD",
  });
  log("Order Created via Checkout", {
    id: checkout.data.id,
    orderNumber: checkout.data.orderNumber,
    status: checkout.data.status,
    grandTotal: checkout.data.grandTotal,
  });

  // ─── Confirm order ───────────────────────────────────────────────
  const confirmed = await api<{ data: Record<string, any> }>(
    "PATCH",
    `/api/orders/${checkout.data.id}/status`,
    { status: "confirmed" },
  );
  log("Order Confirmed", {
    id: confirmed.data.id,
    status: confirmed.data.status,
  });

  // ─── View order ──────────────────────────────────────────────────
  const orderDetail = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/orders/${checkout.data.id}`,
  );
  log("Order Detail", orderDetail.data);

  console.log("\n✅ Cart & checkout flow complete.\n");
}

main().catch(console.error);
