/**
 * Production-Grade Year Simulator
 *
 * Generates 12 months of realistic e-commerce data for "Acme Streetwear"
 * using direct SQL inserts for speed (bypasses service layer for bulk operations).
 *
 * - 200 customers with realistic names, emails, addresses
 * - ~19K orders distributed across Jul 2025 – Jun 2026
 * - Seasonal patterns: November 2-3x (Black Friday), December 1.5x, February trough
 * - Flash sale windows every month (3 days mid-month, 3x spike)
 * - Daily variation: weekdays higher than weekends
 * - Order lifecycle: 60% fulfilled, 15% confirmed, 12% pending, 8% cancelled, 5% refunded
 *
 * Run: bun run generate:year
 * Prerequisite: bun run setup (creates DB + seeds catalog)
 */

import { faker } from "@faker-js/faker";
import { sql } from "@porulle/core/drizzle";
import { createKernel } from "@porulle/core";
import configPromise from "../../commerce.config.js";

faker.seed(2025);

const config = await configPromise;
const kernel = createKernel(config);
const db = (kernel.database as { db: { execute(q: unknown): Promise<unknown> } }).db;

// ─── Configuration ───────────────────────────────────────────────────────────

const YEAR_START = new Date("2025-07-01T00:00:00Z");
const YEAR_END   = new Date("2026-06-30T23:59:59Z");
const BASE_ORDERS_PER_DAY = 40;

const MONTHLY_MULTIPLIER: Record<number, number> = {
  1: 0.8, 2: 0.7, 3: 0.85, 4: 0.9, 5: 0.95, 6: 1.0,
  7: 0.9, 8: 0.95, 9: 1.0, 10: 1.1, 11: 1.8, 12: 1.5,
};

const DAY_MULTIPLIER = [0.6, 1.1, 1.15, 1.1, 1.2, 1.3, 0.7]; // Sun-Sat

function isFlashSale(date: Date): boolean {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if (month === 11 && day >= 25 && day <= 30) return true; // Black Friday week
  if (day >= 15 && day <= 17) return true; // Mid-month flash sale
  return false;
}

// ─── Load catalog ────────────────────────────────────────────────────────────

interface Product { id: string; slug: string; title: string; price: number; }

async function loadProducts(): Promise<Product[]> {
  const result = await db.execute(
    sql`SELECT id, slug, metadata->>'basePrice' AS price FROM sellable_entities WHERE status = 'active'`,
  );
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows ?? result as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    title: String(r.slug).replace(/-/g, " "),
    price: Number(r.price ?? 2999),
  }));
}

// ─── Customer generation ─────────────────────────────────────────────────────

async function generateCustomers(count: number): Promise<string[]> {
  const customerIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = faker.string.uuid();
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${i}@acme-shop.com`;

    try {
      await db.execute(sql`
        INSERT INTO customers (id, user_id, email, first_name, last_name, metadata, created_at, updated_at)
        VALUES (${id}, ${id}, ${email}, ${firstName}, ${lastName}, '{}', NOW(), NOW())
        ON CONFLICT (user_id) DO NOTHING
      `);
      customerIds.push(id);
    } catch {
      customerIds.push(id); // Use anyway
    }
  }
  return customerIds;
}

// ─── Main generator ──────────────────────────────────────────────────────────

async function main() {
  console.log("\n🏪 ACME STREETWEAR — YEAR SIMULATOR");
  console.log("═".repeat(60));
  console.log(`Period: ${YEAR_START.toISOString().slice(0, 10)} → ${YEAR_END.toISOString().slice(0, 10)}`);
  console.log(`Base: ${BASE_ORDERS_PER_DAY} orders/day\n`);

  // Clean previous simulation data
  console.log("🧹 Cleaning previous order data...");
  await db.execute(sql`DELETE FROM order_status_history`);
  await db.execute(sql`DELETE FROM order_line_items`);
  await db.execute(sql`DELETE FROM orders`);

  const products = await loadProducts();
  if (products.length === 0) {
    console.error("❌ No products. Run 'bun run seed' first.");
    process.exit(1);
  }
  console.log(`📦 ${products.length} products loaded`);

  console.log("👥 Generating 200 customers...");
  const customerIds = await generateCustomers(200);
  console.log(`   ✓ ${customerIds.length} customers\n`);

  // ─── Generate orders day by day ──────────────────────────────────

  let totalOrders = 0;
  let sequence = 0;
  const monthStats = new Map<string, number>();
  let currentDate = new Date(YEAR_START);

  while (currentDate <= YEAR_END) {
    const month = currentDate.getUTCMonth() + 1;
    const dow = currentDate.getUTCDay();
    const monthKey = currentDate.toISOString().slice(0, 7);

    let dayCount = BASE_ORDERS_PER_DAY;
    dayCount *= MONTHLY_MULTIPLIER[month] ?? 1.0;
    dayCount *= DAY_MULTIPLIER[dow] ?? 1.0;
    if (isFlashSale(currentDate)) dayCount *= 3.0;
    dayCount *= 0.8 + Math.random() * 0.4;
    dayCount = Math.round(dayCount);

    for (let i = 0; i < dayCount; i++) {
      sequence++;
      const orderId = faker.string.uuid();
      const year = currentDate.getUTCFullYear();
      const orderNumber = `ORD-${year}-${String(sequence).padStart(6, "0")}`;
      const customerId = faker.helpers.arrayElement(customerIds);

      // Pick 1-3 random products
      const itemCount = faker.helpers.weightedArrayElement([
        { value: 1, weight: 50 }, { value: 2, weight: 35 }, { value: 3, weight: 15 },
      ]);
      const items = faker.helpers.arrayElements(products, Math.min(itemCount, products.length));
      const quantities = items.map(() => faker.helpers.weightedArrayElement([
        { value: 1, weight: 60 }, { value: 2, weight: 25 }, { value: 3, weight: 10 }, { value: 5, weight: 5 },
      ]));

      const subtotal = items.reduce((sum, p, idx) => sum + p.price * quantities[idx]!, 0);
      const shipping = faker.helpers.weightedArrayElement([
        { value: 0, weight: 30 }, { value: 499, weight: 40 }, { value: 799, weight: 20 }, { value: 1599, weight: 10 },
      ]);
      const discount = Math.random() < 0.15 ? Math.round(subtotal * 0.1) : 0;
      const grandTotal = subtotal + shipping - discount;

      // Pick lifecycle
      const status = faker.helpers.weightedArrayElement([
        { value: "fulfilled", weight: 60 }, { value: "confirmed", weight: 15 },
        { value: "cancelled", weight: 8 }, { value: "pending", weight: 12 },
        { value: "refunded", weight: 5 },
      ]);

      // Order timestamp within the day
      const placedAt = new Date(currentDate);
      placedAt.setUTCHours(faker.number.int({ min: 6, max: 23 }), faker.number.int({ min: 0, max: 59 }));

      // Insert order
      try {
        await db.execute(sql`
          INSERT INTO orders (id, order_number, customer_id, status, currency, subtotal, tax_total,
                              shipping_total, discount_total, grand_total, payment_intent_id, metadata, placed_at)
          VALUES (${orderId}, ${orderNumber}, ${customerId}, ${status}, 'USD', ${subtotal}, ${0},
                  ${shipping}, ${discount}, ${grandTotal}, ${"pi_sim_" + sequence},
                  ${JSON.stringify({ simulatedAt: placedAt.toISOString() })}, ${placedAt.toISOString()})
        `);

        // Insert line items
        for (let j = 0; j < items.length; j++) {
          const item = items[j]!;
          const qty = quantities[j]!;
          await db.execute(sql`
            INSERT INTO order_line_items (id, order_id, entity_id, entity_type, title, quantity, unit_price, total_price)
            VALUES (${faker.string.uuid()}, ${orderId}, ${item.id}, 'product', ${item.title}, ${qty}, ${item.price}, ${item.price * qty})
          `);
        }

        totalOrders++;
      } catch {
        // Skip rare collisions
      }
    }

    monthStats.set(monthKey, (monthStats.get(monthKey) ?? 0) + dayCount);

    // Progress
    if (currentDate.getUTCDate() % 7 === 1) {
      const bfTag = isFlashSale(currentDate) ? " 🔥" : "";
      process.stdout.write(`\r  ${currentDate.toISOString().slice(0, 10)}  ${dayCount.toString().padStart(3)} orders${bfTag}  (total: ${totalOrders})`);
    }

    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }

  console.log("\n\n📊 MONTHLY SUMMARY");
  console.log("─".repeat(50));
  for (const [month, count] of [...monthStats.entries()].sort()) {
    const bar = "█".repeat(Math.round(count / 80));
    console.log(`  ${month}  ${count.toString().padStart(5)} orders  ${bar}`);
  }
  console.log("─".repeat(50));
  console.log(`  TOTAL      ${totalOrders.toString().padStart(5)} orders`);
  console.log(`  CUSTOMERS  ${customerIds.length}`);
  console.log(`  PRODUCTS   ${products.length}`);

  // Verify
  const dbCount = await db.execute(sql`SELECT COUNT(*) AS c FROM orders`);
  const actualCount = Number(((dbCount as unknown as { rows: Record<string, unknown>[] }).rows ?? dbCount as unknown as Record<string, unknown>[])[0]?.c ?? 0);
  console.log(`  IN DB      ${actualCount} orders`);

  console.log(`\n✅ Year simulation complete!\n`);
  process.exit(0);
}

main().catch((err) => { console.error("Failed:", err); process.exit(1); });
