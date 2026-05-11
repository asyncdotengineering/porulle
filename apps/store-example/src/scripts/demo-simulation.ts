/**
 * End-to-end simulation — realistic user journeys against the running server.
 *
 * Scenarios:
 *   1. Store manager sets up supplier info on products (extended columns)
 *   2. Customer registers, browses, buys, and leaves reviews (custom table + FK joins)
 *   3. Second customer does repeat purchases to reach Silver tier (loyalty)
 *   4. Manager moderates reviews and checks review summaries (aggregation queries)
 *   5. Cross-cutting: verify FK integrity, joined data, and cascades
 *
 * Run: bun run demo:simulate  (server must be running)
 */

import { api, signUp, signIn, resetSession, log, heading } from "./_helpers.js";

const unique = Date.now();

async function registerAndSignIn(name: string, suffix: string) {
  const email = `${suffix}-${unique}@acme-demo.com`;
  const password = "Demo1234!";

  resetSession();

  const signUpResult = await signUp(name, email, password);
  await signIn(email, password);

  return { userId: signUpResult.user.id, email, name };
}

async function main() {
  heading("UNIFIED COMMERCE — END-TO-END SIMULATION");

  // ─────────────────────────────────────────────────────────────────────
  // SCENARIO 1: Store manager sets up supplier info
  // ─────────────────────────────────────────────────────────────────────
  heading("SCENARIO 1 — Store manager: supplier info on products");

  const catalog = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/catalog/entities?type=product",
  );

  if (catalog.data.length < 2) {
    console.error("Not enough products. Run 'bun run seed' first.");
    return;
  }

  const tee = (catalog.data.find((p) => p.slug === "classic-tee") ?? catalog.data[0])!;
  const hoodie = (catalog.data.find((p) => p.slug === "oversized-hoodie") ?? catalog.data[1])!;
  const pants = catalog.data.find((p) => p.slug === "cargo-pants") ?? catalog.data[2]!;

  // Set supplier info (extended columns)
  const teeSupplier = await api<{ data: Record<string, any> }>(
    "PUT",
    `/api/catalog/entities/${tee.id}/supplier`,
    { supplierCode: "SUP-VN-001", countryOfOrigin: "Vietnam" },
  );
  log("Tee supplier info set", teeSupplier.data);

  const hoodieSupplier = await api<{ data: Record<string, any> }>(
    "PUT",
    `/api/catalog/entities/${hoodie.id}/supplier`,
    { supplierCode: "SUP-PT-042", countryOfOrigin: "Portugal" },
  );
  log("Hoodie supplier info set", hoodieSupplier.data);

  // Read back supplier info
  const teeSupplierRead = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/catalog/entities/${tee.id}/supplier`,
  );
  log("Tee supplier info (read back)", teeSupplierRead.data);

  // ─────────────────────────────────────────────────────────────────────
  // SCENARIO 2: Customer Alex — browse, buy, review
  // ─────────────────────────────────────────────────────────────────────
  heading("SCENARIO 2 — Customer Alex: browse → buy → review");

  const alex = await registerAndSignIn("Alex Buyer", "alex");
  log("Alex registered", { userId: alex.userId, email: alex.email });

  // Browse catalog with attributes
  const products = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/catalog/entities?type=product&include=attributes",
  );
  log("Products available", products.data.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.attributes?.[0]?.title ?? p.slug,
  })));

  // Create cart and add items
  const cart = await api<{ data: Record<string, any> }>("POST", "/api/carts", { currency: "USD" });

  await api("POST", `/api/carts/${cart.data.id}/items`, {
    entityId: tee.id,
    quantity: 2,
    unitPriceSnapshot: 2999,
  });

  await api("POST", `/api/carts/${cart.data.id}/items`, {
    entityId: hoodie.id,
    quantity: 1,
    unitPriceSnapshot: 5999,
  });

  const cartContents = await api<{ data: Record<string, any> }>("GET", `/api/carts/${cart.data.id}`);
  log("Alex's cart", {
    items: cartContents.data.lineItems.length,
    subtotal: `$${(cartContents.data.lineItems.reduce(
      (s: number, li: Record<string, any>) => s + li.quantity * li.unitPriceSnapshot, 0
    ) / 100).toFixed(2)}`,
  });

  // Checkout
  const order = await api<{ data: Record<string, any> }>("POST", "/api/checkout", {
    cartId: cart.data.id,
    paymentMethodId: "mock-payments",
    currency: "USD",
    customerId: alex.userId,
    shippingAddress: {
      country: "US",
      postalCode: "90210",
      state: "CA",
      city: "Beverly Hills",
      line1: "456 Fashion Blvd",
    },
  });
  log("Alex's order", {
    orderNumber: order.data.orderNumber,
    grandTotal: `$${(order.data.grandTotal / 100).toFixed(2)}`,
  });

  // Alex leaves reviews
  const review1 = await api<{ data: Record<string, any> }>("POST", "/api/reviews", {
    entityId: tee.id,
    customerId: order.data.customerId,
    rating: 5,
    title: "Perfect everyday tee",
    body: "Great quality cotton, fits true to size. Already ordered another!",
  });
  log("Alex reviewed the tee", { id: review1.data.id, rating: review1.data.rating });

  const review2 = await api<{ data: Record<string, any> }>("POST", "/api/reviews", {
    entityId: hoodie.id,
    customerId: order.data.customerId,
    rating: 4,
    title: "Cozy but runs a bit large",
    body: "Love the material and the oversized fit, but I'd size down.",
  });
  log("Alex reviewed the hoodie", { id: review2.data.id, rating: review2.data.rating });

  // ─────────────────────────────────────────────────────────────────────
  // SCENARIO 3: Customer Maya — repeat buyer, loyalty progression
  // ─────────────────────────────────────────────────────────────────────
  heading("SCENARIO 3 — Customer Maya: repeat buyer → Silver tier");

  const maya = await registerAndSignIn("Maya Shopper", "maya");
  log("Maya registered", { userId: maya.userId, email: maya.email });

  // Maya's first order — big cart
  const cart2 = await api<{ data: Record<string, any> }>("POST", "/api/carts", { currency: "USD" });
  await api("POST", `/api/carts/${cart2.data.id}/items`, {
    entityId: hoodie.id,
    quantity: 5,
    unitPriceSnapshot: 5999,
  });

  const order2 = await api<{ data: Record<string, any> }>("POST", "/api/checkout", {
    cartId: cart2.data.id,
    paymentMethodId: "mock-payments",
    currency: "USD",
    customerId: maya.userId,
    shippingAddress: {
      country: "US",
      postalCode: "10001",
      state: "NY",
      city: "New York",
      line1: "789 Broadway",
    },
  });
  log("Maya's 1st order", {
    orderNumber: order2.data.orderNumber,
    grandTotal: `$${(order2.data.grandTotal / 100).toFixed(2)}`,
  });

  // Check Maya's loyalty after first order
  await new Promise((r) => setTimeout(r, 300));
  const mayaPoints1 = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/loyalty/points/${maya.userId}`,
  );
  log("Maya's loyalty (after 1st order)", {
    points: mayaPoints1.data.points,
    tier: mayaPoints1.data.tier,
  });

  // Maya's second order — push past Silver threshold (500 points = $500 spent)
  const cart3 = await api<{ data: Record<string, any> }>("POST", "/api/carts", { currency: "USD" });
  if (pants) {
    await api("POST", `/api/carts/${cart3.data.id}/items`, {
      entityId: pants.id,
      quantity: 4,
      unitPriceSnapshot: 6499,
    });
  } else {
    await api("POST", `/api/carts/${cart3.data.id}/items`, {
      entityId: tee.id,
      quantity: 10,
      unitPriceSnapshot: 2999,
    });
  }

  const order3 = await api<{ data: Record<string, any> }>("POST", "/api/checkout", {
    cartId: cart3.data.id,
    paymentMethodId: "mock-payments",
    currency: "USD",
    customerId: maya.userId,
    shippingAddress: {
      country: "US",
      postalCode: "10001",
      state: "NY",
      city: "New York",
      line1: "789 Broadway",
    },
  });
  log("Maya's 2nd order", {
    orderNumber: order3.data.orderNumber,
    grandTotal: `$${(order3.data.grandTotal / 100).toFixed(2)}`,
  });

  // Check Maya's loyalty tier
  await new Promise((r) => setTimeout(r, 300));
  const mayaPoints2 = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/loyalty/points/${maya.userId}`,
  );
  log("Maya's loyalty (after 2nd order)", {
    points: mayaPoints2.data.points,
    tier: mayaPoints2.data.tier,
    lifetimeSpend: `$${(mayaPoints2.data.lifetimeSpend / 100).toFixed(2)}`,
  });

  // Maya also leaves a review
  const review3 = await api<{ data: Record<string, any> }>("POST", "/api/reviews", {
    entityId: hoodie.id,
    customerId: order2.data.customerId,
    rating: 5,
    title: "Bought 5, no regrets",
    body: "Got one for each day of the work week. Best hoodie on the market.",
  });
  log("Maya reviewed the hoodie", { id: review3.data.id, rating: review3.data.rating });

  // ─────────────────────────────────────────────────────────────────────
  // SCENARIO 4: Manager — moderate reviews, check summaries
  // ─────────────────────────────────────────────────────────────────────
  heading("SCENARIO 4 — Manager: moderate reviews & view summaries");

  // Get all reviews for the hoodie (joined with product data)
  const hoodieReviews = await api<{ data: Record<string, any>[] }>(
    "GET",
    `/api/reviews/${hoodie.id}`,
  );
  log("Hoodie reviews (with product join)", hoodieReviews.data);

  // Get review summary (average rating)
  const hoodieSummary = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/reviews/${hoodie.id}/summary`,
  );
  log("Hoodie review summary", hoodieSummary.data);

  const teeSummary = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/reviews/${tee.id}/summary`,
  );
  log("Tee review summary", teeSummary.data);

  // Approve reviews
  for (const review of [review1.data, review2.data, review3.data]) {
    await api("PATCH", `/api/reviews/${review.id}/approve`);
  }
  log("Reviews approved", {
    approved: [review1.data.id, review2.data.id, review3.data.id].map(
      (id) => id.slice(0, 8),
    ),
  });

  // ─────────────────────────────────────────────────────────────────────
  // SCENARIO 5: Leaderboard and cross-cutting checks
  // ─────────────────────────────────────────────────────────────────────
  heading("SCENARIO 5 — Cross-cutting: leaderboard, portal, inventory");

  // Loyalty leaderboard
  const leaderboard = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/loyalty/leaderboard",
  );
  log("Loyalty leaderboard", leaderboard.data);

  // Check inventory
  const teeInventory = await api<{ data: Record<string, any> }>(
    "GET",
    `/api/inventory/check?entityIds=${tee.id}`,
  );
  log("Tee inventory", teeInventory.data);

  // Analytics
  try {
    const revenue = await api<{ data: Record<string, any> }>(
      "GET",
      "/api/analytics/revenue/today",
    );
    log("Today's revenue", revenue.data);
  } catch {
    log("Analytics", { note: "Revenue endpoint not available in this config" });
  }

  // ─────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────
  heading("SIMULATION SUMMARY");

  const orderCount = leaderboard.data.length;
  console.log(`
  Customers created:     2 (Alex, Maya)
  Orders placed:         3
  Reviews submitted:     3 (all approved)
  Loyalty accounts:      ${orderCount}
  Maya's tier:           ${mayaPoints2.data.tier} (${mayaPoints2.data.points} points)
  Hoodie avg rating:     ${hoodieSummary.data.averageRating}/5 (${hoodieSummary.data.totalReviews} reviews)
  Tee avg rating:        ${teeSummary.data.averageRating}/5 (${teeSummary.data.totalReviews} reviews)
  Supplier info:         Tee → ${teeSupplier.data.supplierCode} (${teeSupplier.data.countryOfOrigin})
                         Hoodie → ${hoodieSupplier.data.supplierCode} (${hoodieSupplier.data.countryOfOrigin})
  `);

  console.log("✅ Simulation complete!\n");
}

main().catch(console.error);
