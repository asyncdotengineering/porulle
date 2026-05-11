/**
 * Demo: Full customer journey — register, browse, cart, checkout, customer portal.
 *
 * Run: bun run demo:customer  (server must be running, seed must have been run)
 */

import { log, heading } from "./_helpers.js";

const BASE = process.env.API_URL ?? "http://localhost:4000";

// Customer-scoped fetch that carries a session cookie
let sessionCookie: string | null = null;

async function customerFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "origin": BASE,
  };
  if (sessionCookie) headers["cookie"] = sessionCookie;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  // Capture session cookie
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (match) sessionCookie = `better-auth.session_token=${match[1]}`;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// Staff-auth fetch for read-only catalog/search (no login needed for public data,
// but we use staff key to avoid auth issues for catalog reads in this demo)
const STAFF_KEY = process.env.STORE_API_KEY ?? "";
async function staffFetch<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": STAFF_KEY,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function main() {
  // ─── 1. Register a new customer ──────────────────────────────────
  heading("1 · CUSTOMER REGISTRATION");

  const email = `customer-${Date.now()}@acme-demo.com`;
  const password = "Str0ngP@ss!";

  const signUp = await customerFetch<{ user: Record<string, any>; token?: string }>(
    "POST",
    "/api/auth/sign-up/email",
    { name: "Alex Demo", email, password },
  );
  log("Registered", { userId: signUp.user?.id, email: signUp.user?.email, name: signUp.user?.name });

  // ─── 2. Sign in ──────────────────────────────────────────────────
  heading("2 · SIGN IN");

  const signIn = await customerFetch<{ user: Record<string, any>; token?: string }>(
    "POST",
    "/api/auth/sign-in/email",
    { email, password },
  );
  const userId = signIn.user?.id;   // Better Auth user ID (string)
  log("Signed in", { userId, sessionCookieSet: sessionCookie !== null });

  // ─── 3. View & update profile ────────────────────────────────────
  heading("3 · CUSTOMER PROFILE");

  const profile = await customerFetch<{ data: Record<string, any> }>("GET", "/api/me/profile");
  const customerId = profile.data.id; // customer profile UUID (used for checkout)
  log("Profile (before update)", profile.data);

  const updatedProfile = await customerFetch<{ data: Record<string, any> }>("PATCH", "/api/me/profile", {
    firstName: "Alex",
    lastName: "Demo",
    phone: "+1-555-0100",
  });
  log("Profile (after update)", {
    firstName: updatedProfile.data.firstName,
    lastName: updatedProfile.data.lastName,
    phone: updatedProfile.data.phone,
  });

  // ─── 4. Add a shipping address ───────────────────────────────────
  heading("4 · ADD SHIPPING ADDRESS");

  const address = await customerFetch<{ data: Record<string, any> }>("POST", "/api/me/addresses", {
    type: "shipping",
    firstName: "Alex",
    lastName: "Demo",
    line1: "123 Streetwear Ave",
    line2: "Suite 4",
    city: "Los Angeles",
    state: "CA",
    postalCode: "90001",
    country: "US",
    isDefault: true,
  });
  log("Address added", address.data);

  const addresses = await customerFetch<{ data: Record<string, any>[] }>("GET", "/api/me/addresses");
  log("My addresses", addresses.data);

  // ─── 5. Browse the catalog ───────────────────────────────────────
  heading("5 · BROWSE CATALOG");

  const catalog = await customerFetch<{ data: Record<string, any>[]; meta: Record<string, any> }>(
    "GET",
    "/api/catalog/entities?type=product&include=attributes",
  );
  log("Products available", catalog.data.map((p: Record<string, any>) => ({
    id: p.id,
    slug: p.slug,
    title: p.attributes?.[0]?.title ?? p.slug,
  })));

  // ─── 6. Search for products ──────────────────────────────────────
  heading("6 · SEARCH");

  const searchHoodie = await customerFetch<{ data: Record<string, any>[]; meta: Record<string, any> }>(
    "GET",
    "/api/search?q=hoodie",
  );
  log("Search 'hoodie'", { total: searchHoodie.meta?.total, hits: searchHoodie.data.map((h: Record<string, any>) => h.title) });

  const suggest = await customerFetch<{ data: Record<string, any>[] }>(
    "GET",
    "/api/search/suggest?prefix=cargo",
  );
  log("Suggest 'cargo'", suggest.data);

  // ─── 7. Create a cart ────────────────────────────────────────────
  heading("7 · CART");

  const cart = await customerFetch<{ data: Record<string, any> }>("POST", "/api/carts", {
    currency: "USD",
  });
  log("Cart created", { id: cart.data.id, status: cart.data.status });

  // Add a tee and cargo pants
  const tee = catalog.data.find((p: Record<string, any>) => p.slug === "classic-tee");
  const cargo = catalog.data.find((p: Record<string, any>) => p.slug === "cargo-pants");

  if (!tee || !cargo) throw new Error("Products not found — run seed first.");

  const addTee = await customerFetch<{ data: Record<string, any> }>(
    "POST",
    `/api/carts/${cart.data.id}/items`,
    { entityId: tee.id, quantity: 1, unitPriceSnapshot: 2999 },
  );
  log("Added Classic Tee x1", { lineItemId: addTee.data.id });

  const addCargo = await customerFetch<{ data: Record<string, any> }>(
    "POST",
    `/api/carts/${cart.data.id}/items`,
    { entityId: cargo.id, quantity: 1, unitPriceSnapshot: 6499 },
  );
  log("Added Urban Cargo Pants x1", { lineItemId: addCargo.data.id });

  // View cart
  const cartDetail = await customerFetch<{ data: Record<string, any> }>("GET", `/api/carts/${cart.data.id}`);
  const cartSubtotal = cartDetail.data.lineItems?.reduce(
    (sum: number, li: Record<string, any>) => sum + li.unitPriceSnapshot * li.quantity,
    0,
  ) ?? 0;
  log("Cart contents", {
    items: cartDetail.data.lineItems?.map((li: Record<string, any>) => ({
      entityId: li.entityId,
      qty: li.quantity,
    })),
    subtotal: `$${(cartSubtotal / 100).toFixed(2)}`,
  });

  // ─── 8. Validate promotion code ──────────────────────────────────
  heading("8 · PROMOTION CODE VALIDATION");

  const lineItemsForPromo = cartDetail.data.lineItems?.map((li: Record<string, any>) => ({
    entityId: li.entityId,
    entityType: "product",
    quantity: li.quantity,
    unitPrice: li.unitPriceSnapshot,
    totalPrice: li.unitPriceSnapshot * li.quantity,
  })) ?? [];

  const promoCheck = await customerFetch<{ data: Record<string, any> }>("POST", "/api/promotions/validate", {
    code: "WELCOME10",
    currency: "USD",
    subtotal: cartSubtotal,
    lineItems: lineItemsForPromo,
  });
  log("Promo WELCOME10 validation", {
    valid: promoCheck.data.valid ?? promoCheck.data.isValid,
    discount: promoCheck.data,
  });

  // ─── 9. Checkout ─────────────────────────────────────────────────
  heading("9 · CHECKOUT");

  const shippingAddress = {
    line1: "123 Streetwear Ave",
    city: "Los Angeles",
    state: "CA",
    postalCode: "90001",
    country: "US",
  };

  const checkout = await customerFetch<{ data: Record<string, any> }>("POST", "/api/checkout", {
    cartId: cart.data.id,
    paymentMethodId: "mock-payments",
    currency: "USD",
    customerId,                  // customer profile UUID — ties order to this customer
    promotionCodes: ["WELCOME10"],
    shippingAddress,
  });

  log("Order created", {
    orderNumber: checkout.data.orderNumber,
    status: checkout.data.status,
    subtotal: `$${(checkout.data.subtotal / 100).toFixed(2)}`,
    discountTotal: `$${(checkout.data.discountTotal / 100).toFixed(2)}`,
    shippingTotal: `$${(checkout.data.shippingTotal / 100).toFixed(2)}`,
    taxTotal: `$${(checkout.data.taxTotal / 100).toFixed(2)}`,
    grandTotal: `$${(checkout.data.grandTotal / 100).toFixed(2)}`,
    appliedPromotions: checkout.data.metadata?.appliedPromotions?.map((p: Record<string, any>) => p.code),
    lineItems: checkout.data.lineItems?.map((li: Record<string, any>) => ({
      title: li.title,
      qty: li.quantity,
      price: `$${(li.unitPrice / 100).toFixed(2)}`,
    })),
  });

  const orderId = checkout.data.id;

  // ─── 10. Customer portal — my orders ─────────────────────────────
  heading("10 · CUSTOMER PORTAL — MY ORDERS");

  const myOrders = await customerFetch<{ data: Record<string, any>[]; meta: Record<string, any> }>("GET", "/api/me/orders");
  log("My orders", myOrders.data.map((o: Record<string, any>) => ({
    orderNumber: o.orderNumber,
    status: o.status,
    grandTotal: `$${(o.grandTotal / 100).toFixed(2)}`,
    placedAt: o.placedAt,
  })));

  // ─── 11. Order detail via customer portal ────────────────────────
  heading("11 · ORDER DETAIL (customer view)");

  const orderDetail = await customerFetch<{ data: Record<string, any> }>(
    "GET",
    `/api/me/orders/${orderId}`,
  );
  log("Order detail", {
    orderNumber: orderDetail.data.orderNumber,
    status: orderDetail.data.status,
    grandTotal: `$${(orderDetail.data.grandTotal / 100).toFixed(2)}`,
    lineItems: orderDetail.data.lineItems?.map((li: Record<string, any>) => ({
      title: li.title,
      qty: li.quantity,
      fulfillmentStatus: li.fulfillmentStatus,
    })),
  });

  // ─── 12. Order tracking ──────────────────────────────────────────
  heading("12 · ORDER TRACKING");

  const tracking = await customerFetch<{ data: Record<string, any>[] }>(
    "GET",
    `/api/me/orders/${orderId}/tracking`,
  );
  log("Fulfillment / tracking", tracking.data.map((f: Record<string, any>) => ({
    fulfillmentId: f.fulfillmentId,
    status: f.status,
    carrier: f.carrier ?? "(not yet assigned)",
    trackingNumber: f.trackingNumber ?? "(not yet assigned)",
  })));

  // ─── 13. Try to access another order (should be forbidden) ───────
  heading("13 · PERMISSION CHECK — cannot see other customer orders");

  try {
    // Use staff API to get an order, then try to read it as the customer
    const allOrders = await staffFetch<{ data: Record<string, any>[] }>("GET", "/api/orders");
    const foreignOrder = allOrders.data.find((o: Record<string, any>) => o.customerId !== customerId);

    if (foreignOrder) {
      await customerFetch("GET", `/api/me/orders/${foreignOrder.id}`);
      log("⚠️  Unexpected: customer could see another customer's order", { id: foreignOrder.id });
    } else {
      log("No foreign order to test against (all orders belong to this customer)", {});
    }
  } catch (err: unknown) {
    log("✅ Correctly blocked — cannot see another customer's order", {
      error: (err as Error).message.slice(0, 120),
    });
  }

  // ─── 14. Delete address cleanup ──────────────────────────────────
  heading("14 · CLEANUP — remove address");

  if (addresses.data[0]) {
    await customerFetch("DELETE", `/api/me/addresses/${addresses.data[0].id}`);
    const afterDelete = await customerFetch<{ data: Record<string, any>[] }>("GET", "/api/me/addresses");
    log("Addresses after delete", { count: afterDelete.data.length });
  }

  console.log("\n✅ Customer journey demo complete.\n");
}

main().catch(console.error);
