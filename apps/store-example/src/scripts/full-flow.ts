/**
 * Full E2E Demo — exercises the entire commerce engine via the kernel.
 *
 * This script demonstrates the complete lifecycle:
 *   1. Catalog management (create, categorize, price)
 *   2. Inventory setup (warehouses, stock, cost tracking)
 *   3. Customer creation
 *   4. Cart → Order flow
 *   5. Order lifecycle (confirm → fulfill)
 *   6. Analytics queries
 *
 * Run: bun run demo:all
 */

import { createKernel, type Actor } from "@porulle/core";
import configPromise from "../../commerce.config.js";

const config = await configPromise;
const kernel = createKernel(config);

const staff: Actor = {
  type: "user",
  userId: "demo-staff",
  email: "staff@acme.com",
  name: "Demo Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "inventory:adjust",
    "inventory:read",
    "orders:create",
    "orders:read",
    "orders:update",
    "cart:create",
    "cart:update",
    "customers:read",
  ],
};

function ok<T>(label: string, result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    console.error(`  ✗ ${label} FAILED:`, result.error);
    process.exit(1);
  }
  return result.value;
}

function step(n: number, label: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Step ${n}: ${label}`);
  console.log(`${"─".repeat(60)}`);
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         UNIFIED COMMERCE ENGINE — FULL DEMO          ║
╚══════════════════════════════════════════════════════╝
`);

  // ═══════════════════════════════════════════════════════════════════
  step(1, "Create a category and brand");

  const category = ok(
    "Create category",
    await kernel.services.catalog.createCategory(
      { slug: "limited-edition" },
      staff,
    ),
  );
  console.log(`  ✓ Category: ${category.slug} (${category.id})`);

  const brand = ok(
    "Create brand",
    await kernel.services.catalog.createBrand(
      { displayName: "Demo Brand", slug: "demo-brand" },
      staff,
    ),
  );
  console.log(`  ✓ Brand: ${brand.displayName} (${brand.id})`);

  // ═══════════════════════════════════════════════════════════════════
  step(2, "Create a product and publish it");

  const product = ok(
    "Create product",
    await kernel.services.catalog.create(
      {
        type: "product",
        slug: "demo-limited-jacket",
        attributes: {
          title: "Limited Edition Bomber Jacket",
          description: "One-of-a-kind bomber. Only 20 units made.",
        },
        metadata: { basePrice: 14999, weight: 900, material: "Leather" },
      },
      staff,
    ),
  );
  console.log(
    `  ✓ Product: ${product.slug} (${product.id}) — status: ${product.status}`,
  );

  ok("Publish", await kernel.services.catalog.publish(product.id, staff));
  console.log(`  ✓ Published`);

  ok(
    "Add to category",
    await kernel.services.catalog.addToCategory(product.id, category.id),
  );
  ok(
    "Add to brand",
    await kernel.services.catalog.addToBrand(product.id, brand.id),
  );
  console.log(`  ✓ Linked to "${category.slug}" + "${brand.displayName}"`);

  // ═══════════════════════════════════════════════════════════════════
  step(3, "Set pricing");

  const price = ok(
    "Create price",
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 14999,
    }, staff),
  );
  console.log(
    `  ✓ Price: $${(price.amount / 100).toFixed(2)} ${price.currency}`,
  );

  // ═══════════════════════════════════════════════════════════════════
  step(4, "Set up warehouse and stock");

  const warehouse = ok(
    "Create warehouse",
    await kernel.services.inventory.createWarehouse({
      name: "Demo Warehouse",
      code: "DEMO",
    }, staff),
  );
  console.log(`  ✓ Warehouse: ${warehouse.name} (${warehouse.code})`);

  const level = ok(
    "Adjust inventory",
    await kernel.services.inventory.adjust(
      {
        entityId: product.id,
        warehouseId: warehouse.id,
        adjustment: 20,
        reason: "initial_stock",
      },
      staff,
    ),
  );
  console.log(`  ✓ Stocked: ${level.quantityOnHand} units on hand`);

  ok(
    "Set unit cost",
    await kernel.services.inventory.setUnitCost(product.id, warehouse.id, 4500),
  );
  console.log(`  ✓ Unit cost: $45.00 (for COGS tracking)`);

  // ═══════════════════════════════════════════════════════════════════
  step(5, "Create a customer");

  // getByUserId auto-creates the customer record, then update with details
  ok(
    "Create customer",
    await kernel.services.customers.getByUserId("demo-buyer", staff),
  );
  const customer = ok(
    "Update customer",
    await kernel.services.customers.updateByUserId("demo-buyer", {
      email: "buyer@example.com",
      firstName: "Alex",
      lastName: "Johnson",
    }, staff),
  );
  console.log(
    `  ✓ Customer: ${customer.firstName} ${customer.lastName} (${customer.email})`,
  );

  // ═══════════════════════════════════════════════════════════════════
  step(6, "Create cart and add items");

  const cart = ok(
    "Create cart",
    await kernel.services.cart.create({
      currency: "USD",
      customerId: customer.id,
    }, staff),
  );
  console.log(`  ✓ Cart: ${cart.id}`);

  ok(
    "Add item to cart",
    await kernel.services.cart.addItem({
      cartId: cart.id,
      entityId: product.id,
      quantity: 2,
      unitPriceSnapshot: 14999,
    }, staff),
  );
  console.log(`  ✓ Added 2x Limited Edition Bomber Jacket`);

  const cartView = ok("Get cart", await kernel.services.cart.getById(cart.id, staff));
  console.log(`  Cart has ${cartView.lineItems?.length ?? 0} line item(s)`);

  // ═══════════════════════════════════════════════════════════════════
  step(7, "Place an order");

  const subtotal = 14999 * 2;
  const taxTotal = Math.round(subtotal * 0.08);
  const shippingTotal = 1199; // weight: 900g x2 = 1800g → bracket
  const grandTotal = subtotal + taxTotal + shippingTotal;

  const order = ok(
    "Create order",
    await kernel.services.orders.create(
      {
        customerId: customer.id,
        currency: "USD",
        subtotal,
        taxTotal,
        shippingTotal,
        discountTotal: 0,
        grandTotal,
        lineItems: [
          {
            entityId: product.id,
            entityType: "product",
            title: "Limited Edition Bomber Jacket",
            quantity: 2,
            unitPrice: 14999,
            totalPrice: 29998,
          },
        ],
      },
      staff,
    ),
  );
  console.log(`  ✓ Order: ${order.orderNumber}`);
  console.log(`    Subtotal:  $${(subtotal / 100).toFixed(2)}`);
  console.log(`    Tax:       $${(taxTotal / 100).toFixed(2)}`);
  console.log(`    Shipping:  $${(shippingTotal / 100).toFixed(2)}`);
  console.log(`    Total:     $${(grandTotal / 100).toFixed(2)}`);

  // ═══════════════════════════════════════════════════════════════════
  step(8, "Order lifecycle: confirm → processing");

  ok(
    "Confirm",
    await kernel.services.orders.changeStatus(
      { orderId: order.id, newStatus: "confirmed" },
      staff,
    ),
  );
  console.log(`  ✓ Status: confirmed`);

  ok(
    "Processing",
    await kernel.services.orders.changeStatus(
      { orderId: order.id, newStatus: "processing" },
      staff,
    ),
  );
  console.log(`  ✓ Status: processing`);

  // ═══════════════════════════════════════════════════════════════════
  step(9, "Check updated inventory");

  const avail = ok(
    "Check stock",
    await kernel.services.inventory.getAvailable(product.id),
  );
  console.log(`  Available stock for bomber jacket: ${avail} units`);

  // ═══════════════════════════════════════════════════════════════════
  step(10, "Run analytics");

  const adminScope = { role: "admin" as const };

  const revenueResult = await kernel.services.analytics.query({
    measures: ["Orders.revenue", "Orders.count"],
  }, adminScope);
  if (revenueResult.ok) {
    const rows = revenueResult.value.rows as Record<string, number>[];
    const row = rows[0];
    console.log(
      `  Revenue: $${((row?.["Orders.revenue"] ?? 0) / 100).toFixed(2)}  |  Orders: ${row?.["Orders.count"] ?? 0}`,
    );
  }

  const invValue = await kernel.services.analytics.query({
    measures: ["Inventory.inventoryValue"],
  }, adminScope);
  if (invValue.ok) {
    const rows = invValue.value.rows as Record<string, number>[];
    const row = rows[0];
    console.log(
      `  Inventory value: $${((row?.["Inventory.inventoryValue"] ?? 0) / 100).toFixed(2)}`,
    );
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  ✅ FULL DEMO COMPLETE");
  console.log(`${"═".repeat(60)}\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
