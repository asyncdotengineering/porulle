/**
 * Demo: Loyalty Plugin Testing
 *
 * Tests the loyalty plugin by:
 * 1. Creating an order (should award points)
 * 2. Checking customer points
 * 3. Viewing leaderboard
 * 4. Redeeming points
 *
 * Run: bun run demo:loyalty  (server must be running)
 */

import { api, log, heading } from "./_helpers.js";

async function main() {
  heading("LOYALTY PLUGIN TEST");

  // ─── Step 1: Use existing customer from seed data ───────────────────────────
  heading("1 · Using existing customer (customer-jane from seed data)");

  // The seed data creates a customer with user_id "customer-jane"
  const testUserId = "customer-jane";

  // ─── Step 2: Check initial loyalty points (should be 0) ───────────────────────
  heading("2 · Check initial loyalty points");

  const initialPoints = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/loyalty/points/${testUserId}`,
  );
  log("Initial Points", initialPoints.data);

  // ─── Step 3: Create cart ───────────────────────────────────────────────────────
  heading("3 · Create cart");

  // First, get a product to add to cart
  const catalog = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/catalog/entities?type=product&include=attributes",
  );

  if (catalog.data.length === 0) {
    console.error("No products found. Run 'bun run seed' first.");
    return;
  }

  const product = catalog.data[0]!;

  // Create cart
  const cart = await api<{ data: Record<string, any> }>("POST", "/api/carts", {
    currency: "USD",
  });
  log("Cart created", { id: cart.data.id });

  // Add product to cart (buy 10 items to earn significant points)
  const addItem = await api<{ data: Record<string, any> }>(
    "POST",
    `/api/carts/${cart.data.id}/items`,
    {
      entityId: product.id,
      quantity: 10,
      unitPriceSnapshot: product.metadata?.basePrice ?? 2999,
    },
  );
  log("Added 10 items to cart", { lineItemId: addItem.data.id });

  // ─── Step 4: Checkout with customer ID (should trigger loyalty hook) ───────────
  heading("4 · Checkout (this should award loyalty points)");

  let checkout;
  try {
    checkout = await api<{ data: Record<string, any> }>("POST", "/api/checkout", {
      cartId: cart.data.id,
      paymentMethodId: "mock-payments",
      currency: "USD",
      customerId: testUserId, // This triggers the loyalty hook
      shippingAddress: {
        country: "US",
        postalCode: "90001",
        state: "CA",
        city: "Los Angeles",
        line1: "123 Test St",
      },
    });

    log("Order created", {
      orderId: checkout.data.id,
      orderNumber: checkout.data.orderNumber,
      grandTotal: `$${(checkout.data.grandTotal / 100).toFixed(2)}`,
    });

    const expectedPoints = Math.floor(checkout.data.grandTotal / 100);
    log("Expected Points", { expectedPoints, note: "1 point per $1" });
  } catch (error: unknown) {
    log("Checkout failed", { error: (error as Error).message });
    console.log("Note: Checkout may fail due to payment/mock issues. Plugin hook still works if order was created.");
    // Continue to test points anyway
  }

  // ─── Step 5: Check loyalty points after order ──────────────────────────────────
  heading("5 · Check loyalty points after order");

  // Wait a moment for the hook to process
  await new Promise((resolve) => setTimeout(resolve, 500));

  const updatedPoints = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/loyalty/points/${testUserId}`,
  );
  log("Updated Points", updatedPoints.data);

  // ─── Step 6: View leaderboard ───────────────────────────────────────────────────
  heading("6 · View loyalty leaderboard");

  const leaderboard = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/loyalty/leaderboard",
  );
  log("Leaderboard (top 10)", leaderboard.data);

  // ─── Step 7: Test point redemption ──────────────────────────────────────────────
  heading("7 · Test point redemption");

  if (updatedPoints.data.points > 0) {
    const redeemPoints = Math.min(100, updatedPoints.data.points);

    const redeemed = await api<{ data: Record<string, any> }>("POST", "/api/loyalty/redeem", {
      customerId: testUserId,
      pointsToRedeem: redeemPoints,
    });
    log("Points Redeemed", redeemed.data);

    // Check final points
    const finalPoints = await api<{ data: Record<string, any> }>(
      "GET",
      `/api/loyalty/points/${testUserId}`,
    );
    log("Final Points after redemption", finalPoints.data);
  }

  // ─── Step 8: Create another order to test tier upgrades ─────────────────────────
  heading("8 · Create second order to test tier progression");

  // Create another cart and checkout
  const cart2 = await api<{ data: Record<string, any> }>("POST", "/api/carts", {
    currency: "USD",
  });

  await api<{ data: Record<string, any> }>(
    "POST",
    `/api/carts/${cart2.data.id}/items`,
    {
      entityId: product.id,
      quantity: 20,
      unitPriceSnapshot: product.metadata?.basePrice ?? 2999,
    },
  );

  let checkout2;
  try {
    checkout2 = await api<{ data: Record<string, any> }>("POST", "/api/checkout", {
      cartId: cart2.data.id,
      paymentMethodId: "mock-payments",
      currency: "USD",
      customerId: testUserId,
      shippingAddress: {
        country: "US",
        postalCode: "90001",
        state: "CA",
        city: "Los Angeles",
        line1: "123 Test St",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const finalTierPoints = await api<{ data: Record<string, any> }>(
      "GET",
      `/api/loyalty/points/${testUserId}`,
    );
    log("Points after second order", {
      points: finalTierPoints.data.points,
      tier: finalTierPoints.data.tier,
    });
  } catch (error: unknown) {
    log("Second checkout failed", { error: (error as Error).message });
  }

  // Show tier thresholds for reference
  log("Tier Thresholds", {
    bronze: "0 points",
    silver: "500 points ($500 spent)",
    gold: "1,500 points ($1,500 spent)",
    platinum: "3,000 points ($3,000 spent)",
  });

  console.log("\n✅ Loyalty plugin test complete!\n");
}

main().catch(console.error);
