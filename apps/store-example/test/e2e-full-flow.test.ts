/**
 * E2E Full Flow Tests — exercises the commerce engine against a real PostgreSQL database
 * and verifies database state after each operation.
 *
 * Prerequisites:
 *   1. PostgreSQL running on localhost:5432
 *   2. `bun run db:reset` (creates DB + pushes schema)
 *   3. Core package built: `cd packages/core && bun run build`
 *
 * Run: bun run test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel, buildSchema, getSchema, type Actor } from "@porulle/core";
import { eq, sql } from "@porulle/core/drizzle";
import configPromise from "../commerce.config.js";
import { loyaltyPoints, loyaltyTransactions } from "../src/plugins/loyalty-schema.js";

// All Drizzle table definitions exposed via getSchema()
const {
  sellableEntities,
  sellableAttributes,
  categories,
  entityCategories,
  brands,
  entityBrands,
  warehouses,
  inventoryLevels,
  inventoryMovements,
  carts,
  cartLineItems,
  orders,
  orderLineItems,
  orderStatusHistory,
  customers,
  prices,
  promotions,
  organization,
} = getSchema();

type Kernel = ReturnType<typeof createKernel>;
type DrizzleDb = Kernel["database"]["db"];

// E2E_ORG_ID is a real test-scoped organization. Seeded in beforeAll. We
// avoid the deprecated DEFAULT_ORG_ID fallback (org_default) — when that
// constant is removed, this test should not need to change.
const E2E_ORG_ID = "org_e2e_full_flow";

// This is a *functional* end-to-end test — it exercises the full commerce
// flow (catalog → inventory → cart → order → analytics → loyalty), not the
// permission boundary. Permission/ownership rejection paths are covered in
// packages/core/test/auth-permissions.test.ts and elsewhere via
// testNoPermActor. The actor here is the operator/cashier persona, which in
// this codebase means role "admin" with *:* — assertOwnership is strict
// (no role-based bypass; see auth-permissions.test.ts:25-28), so anything
// less can't manage a customer-linked cart.
const admin: Actor = {
  type: "user",
  userId: "e2e-admin",
  email: "admin@e2e.test",
  name: "E2E Admin",
  vendorId: null,
  organizationId: E2E_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

let kernel: Kernel;
let db: DrizzleDb;

/**
 * Helper: cast db to the Drizzle query builder type.
 * kernel.database.db is typed as `unknown` — we narrow it for direct queries.
 */
function drizzle() {
  return db as import("@porulle/core/drizzle").PostgresJsDatabase<Record<string, unknown>>;
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`Expected ok result, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe("E2E: Full Commerce Flow with DB Verification", () => {
  beforeAll(async () => {
    const config = await configPromise;
    // Pin the test's org as the boot-time default. createKernel now applies
    // this to setBootDefaultOrgId, so service paths that auto-create rows
    // without an actor (e.g. inventory's pickWarehouse "Default Warehouse"
    // fallback) use E2E_ORG_ID instead of falling back to the deprecated
    // DEFAULT_ORG_ID and producing FK violations.
    const testConfig = {
      ...config,
      auth: { ...config.auth, defaultOrganizationId: E2E_ORG_ID },
    };
    kernel = createKernel(testConfig);
    db = kernel.database.db;

    // Truncate all tables for a clean slate
    await drizzle().execute(sql`
      DO $$ DECLARE r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);

    // Seed a real test organization. Every multi-tenant FK (categories,
    // brands, sellable_entities, carts, orders, ...) references
    // organization.id, so this row must exist before any commerce write.
    // The admin actor's organizationId is set to E2E_ORG_ID so resolveOrgId
    // does not fall back to the deprecated DEFAULT_ORG_ID path.
    await drizzle().insert(organization).values({
      id: E2E_ORG_ID,
      name: "E2E Full Flow Org",
      slug: "e2e-full-flow",
      createdAt: new Date(),
    }).onConflictDoNothing();
  });

  afterAll(async () => {
    // No cleanup needed — tables are truncated at the start
  });

  // ─── Tracked IDs across tests ──────────────────────────────────────

  let categoryId: string;
  let brandId: string;
  let productId: string;
  let warehouseId: string;
  let customerId: string;     // customer profile UUID
  let cartId: string;
  let orderId: string;
  let orderNumber: string;
  let promoId: string;

  // ═══════════════════════════════════════════════════════════════════
  // 1. CATALOG
  // ═══════════════════════════════════════════════════════════════════

  describe("1 — Catalog", () => {
    it("creates a category and verifies it in the DB", async () => {
      const result = ok(
        await kernel.services.catalog.createCategory({ slug: "e2e-tops" }, admin),
      );
      categoryId = result.id;

      const [row] = await drizzle().select().from(categories).where(eq(categories.id, categoryId));
      expect(row).toBeDefined();
      expect(row!.slug).toBe("e2e-tops");
    });

    it("creates a brand and verifies it in the DB", async () => {
      const result = ok(
        await kernel.services.catalog.createBrand(
          { displayName: "E2E Brand", slug: "e2e-brand" },
          admin,
        ),
      );
      brandId = result.id;

      const [row] = await drizzle().select().from(brands).where(eq(brands.id, brandId));
      expect(row).toBeDefined();
      expect(row!.displayName).toBe("E2E Brand");
      expect(row!.slug).toBe("e2e-brand");
    });

    it("creates a product with attributes and verifies in DB", async () => {
      const result = ok(
        await kernel.services.catalog.create(
          {
            type: "product",
            slug: "e2e-jacket",
            attributes: {
              title: "E2E Test Jacket",
              description: "A test product for E2E verification.",
            },
            metadata: { basePrice: 9999, weight: 500 },
          },
          admin,
        ),
      );
      productId = result.id;

      // Verify entity row
      const [entity] = await drizzle()
        .select()
        .from(sellableEntities)
        .where(eq(sellableEntities.id, productId));
      expect(entity).toBeDefined();
      expect(entity!.slug).toBe("e2e-jacket");
      expect(entity!.type).toBe("product");
      expect(entity!.status).toBe("draft");

      // Verify attributes row
      const [attr] = await drizzle()
        .select()
        .from(sellableAttributes)
        .where(eq(sellableAttributes.entityId, productId));
      expect(attr).toBeDefined();
      expect(attr!.title).toBe("E2E Test Jacket");
      expect(attr!.description).toBe("A test product for E2E verification.");
    });

    it("publishes the product and verifies status changes in DB", async () => {
      ok(await kernel.services.catalog.publish(productId, admin));

      const [entity] = await drizzle()
        .select()
        .from(sellableEntities)
        .where(eq(sellableEntities.id, productId));
      expect(entity!.status).toBe("active");
      expect(entity!.publishedAt).not.toBeNull();
    });

    it("links product to category and brand, verifies join tables", async () => {
      ok(await kernel.services.catalog.addToCategory(productId, categoryId, admin));
      ok(await kernel.services.catalog.addToBrand(productId, brandId, admin));

      const [catLink] = await drizzle()
        .select()
        .from(entityCategories)
        .where(eq(entityCategories.entityId, productId));
      expect(catLink).toBeDefined();
      expect(catLink!.categoryId).toBe(categoryId);

      const [brandLink] = await drizzle()
        .select()
        .from(entityBrands)
        .where(eq(entityBrands.entityId, productId));
      expect(brandLink).toBeDefined();
      expect(brandLink!.brandId).toBe(brandId);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. PRICING
  // ═══════════════════════════════════════════════════════════════════

  describe("2 — Pricing", () => {
    it("sets base price and verifies in DB", async () => {
      ok(
        await kernel.services.pricing.setBasePrice({
          entityId: productId,
          currency: "USD",
          amount: 9999,
        }, admin),
      );

      const [row] = await drizzle()
        .select()
        .from(prices)
        .where(eq(prices.entityId, productId));
      expect(row).toBeDefined();
      expect(row!.amount).toBe(9999);
      expect(row!.currency).toBe("USD");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. INVENTORY
  // ═══════════════════════════════════════════════════════════════════

  describe("3 — Inventory", () => {
    it("creates a warehouse and verifies in DB", async () => {
      const result = ok(
        await kernel.services.inventory.createWarehouse({
          name: "E2E Warehouse",
          code: "E2E",
        }, admin),
      );
      warehouseId = result.id;

      const [row] = await drizzle()
        .select()
        .from(warehouses)
        .where(eq(warehouses.id, warehouseId));
      expect(row).toBeDefined();
      expect(row!.name).toBe("E2E Warehouse");
      expect(row!.code).toBe("E2E");
      expect(row!.isActive).toBe(true);
    });

    it("adjusts inventory (+20) and verifies level + movement in DB", async () => {
      const result = ok(
        await kernel.services.inventory.adjust(
          {
            entityId: productId,
            warehouseId,
            adjustment: 20,
            reason: "initial_stock",
          },
          admin,
        ),
      );
      expect(result.quantityOnHand).toBe(20);

      // Verify inventory level
      const [level] = await drizzle()
        .select()
        .from(inventoryLevels)
        .where(eq(inventoryLevels.entityId, productId));
      expect(level).toBeDefined();
      expect(level!.quantityOnHand).toBe(20);
      expect(level!.quantityReserved).toBe(0);
      expect(level!.warehouseId).toBe(warehouseId);

      // Verify movement was recorded
      const movements = await drizzle()
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.entityId, productId));
      expect(movements.length).toBeGreaterThanOrEqual(1);
      const latest = movements[movements.length - 1]!;
      expect(latest.quantity).toBe(20);
      expect(latest.reason).toBe("initial_stock");
    });

    it("sets unit cost and verifies in DB", async () => {
      ok(await kernel.services.inventory.setUnitCost(productId, warehouseId, 3000));

      const [level] = await drizzle()
        .select()
        .from(inventoryLevels)
        .where(eq(inventoryLevels.entityId, productId));
      expect(level!.unitCost).toBe(3000);
    });

    it("getAvailable returns correct stock", async () => {
      const available = ok(await kernel.services.inventory.getAvailable(productId));
      expect(available).toBe(20);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. CUSTOMER
  // ═══════════════════════════════════════════════════════════════════

  describe("4 — Customer", () => {
    it("creates a customer (auto via getByUserId) and verifies in DB", async () => {
      ok(await kernel.services.customers.getByUserId("e2e-buyer", admin));
      const result = ok(
        await kernel.services.customers.updateByUserId("e2e-buyer", {
          email: "buyer@e2e.test",
          firstName: "E2E",
          lastName: "Buyer",
        }, admin),
      );
      customerId = result.id;

      const [row] = await drizzle()
        .select()
        .from(customers)
        .where(eq(customers.id, customerId));
      expect(row).toBeDefined();
      expect(row!.userId).toBe("e2e-buyer");
      expect(row!.email).toBe("buyer@e2e.test");
      expect(row!.firstName).toBe("E2E");
      expect(row!.lastName).toBe("Buyer");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. PROMOTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("5 — Promotions", () => {
    it("creates a promotion and verifies in DB", async () => {
      const result = ok(
        await kernel.services.promotions.create({
          name: "E2E 15% Off",
          code: "E2E15",
          type: "percentage_off_order",
          value: 15,
          isActive: true,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        }, admin),
      );
      promoId = result.id;

      const [row] = await drizzle()
        .select()
        .from(promotions)
        .where(eq(promotions.id, promoId));
      expect(row).toBeDefined();
      expect(row!.code).toBe("E2E15");
      expect(row!.type).toBe("percentage_off_order");
      expect(row!.value).toBe(15);
      expect(row!.isActive).toBe(true);
    });

    it("validates the promotion code", async () => {
      const result = ok(
        await kernel.services.promotions.validate("E2E15", {
          currency: "USD",
          subtotal: 10000,
          lineItems: [
            { entityId: productId, entityType: "product", quantity: 1, unitPrice: 9999, totalPrice: 9999 },
          ],
        }),
      );
      expect(result.code).toBe("E2E15");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. CART
  // ═══════════════════════════════════════════════════════════════════

  describe("6 — Cart", () => {
    it("creates a cart and verifies in DB", async () => {
      const result = ok(
        await kernel.services.cart.create({ currency: "USD", customerId }, admin),
      );
      cartId = result.id;

      const [row] = await drizzle()
        .select()
        .from(carts)
        .where(eq(carts.id, cartId));
      expect(row).toBeDefined();
      expect(row!.status).toBe("active");
      expect(row!.currency).toBe("USD");
      expect(row!.customerId).toBe(customerId);
    });

    it("adds an item to cart and verifies line item in DB", async () => {
      ok(
        await kernel.services.cart.addItem(
          { cartId, entityId: productId, quantity: 3, unitPriceSnapshot: 9999 },
          admin,
        ),
      );

      const items = await drizzle()
        .select()
        .from(cartLineItems)
        .where(eq(cartLineItems.cartId, cartId));
      expect(items.length).toBe(1);
      expect(items[0]!.entityId).toBe(productId);
      expect(items[0]!.quantity).toBe(3);
      expect(items[0]!.unitPriceSnapshot).toBe(9999);
    });

    it("adding same item again merges quantity (deduplication)", async () => {
      ok(
        await kernel.services.cart.addItem(
          { cartId, entityId: productId, quantity: 2, unitPriceSnapshot: 9999 },
          admin,
        ),
      );

      const items = await drizzle()
        .select()
        .from(cartLineItems)
        .where(eq(cartLineItems.cartId, cartId));
      expect(items.length).toBe(1); // still 1 line item
      expect(items[0]!.quantity).toBe(5); // 3 + 2 = 5
    });

    it("getById returns correct cart with line items", async () => {
      const cart = ok(await kernel.services.cart.getById(cartId, admin));
      expect(cart.id).toBe(cartId);
      expect(cart.lineItems.length).toBe(1);
      expect(cart.lineItems[0]!.quantity).toBe(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. CHECKOUT → ORDER
  // ═══════════════════════════════════════════════════════════════════

  describe("7 — Order Creation", () => {
    it("creates an order and verifies order + line items in DB", async () => {
      const result = ok(
        await kernel.services.orders.create(
          {
            customerId,
            currency: "USD",
            subtotal: 49995,        // 5 × $99.99
            taxTotal: 4000,
            shippingTotal: 1199,
            discountTotal: 0,
            grandTotal: 55194,
            lineItems: [
              {
                entityId: productId,
                entityType: "product",
                title: "E2E Test Jacket",
                quantity: 5,
                unitPrice: 9999,
                totalPrice: 49995,
              },
            ],
          },
          admin,
        ),
      );
      orderId = result.id;
      orderNumber = result.orderNumber;

      // Verify order row
      const [orderRow] = await drizzle()
        .select()
        .from(orders)
        .where(eq(orders.id, orderId));
      expect(orderRow).toBeDefined();
      expect(orderRow!.customerId).toBe(customerId);
      expect(orderRow!.status).toBe("pending");
      expect(orderRow!.currency).toBe("USD");
      expect(orderRow!.subtotal).toBe(49995);
      expect(orderRow!.taxTotal).toBe(4000);
      expect(orderRow!.shippingTotal).toBe(1199);
      expect(orderRow!.grandTotal).toBe(55194);
      expect(orderRow!.orderNumber).toBe(orderNumber);

      // Verify line items
      const items = await drizzle()
        .select()
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, orderId));
      expect(items.length).toBe(1);
      expect(items[0]!.entityId).toBe(productId);
      expect(items[0]!.entityType).toBe("product");
      expect(items[0]!.title).toBe("E2E Test Jacket");
      expect(items[0]!.quantity).toBe(5);
      expect(items[0]!.unitPrice).toBe(9999);
      expect(items[0]!.totalPrice).toBe(49995);

      // Verify initial status history entry
      const history = await drizzle()
        .select()
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, orderId));
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0]!.toStatus).toBe("pending");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. ORDER STATUS TRANSITIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("8 — Order Status Transitions", () => {
    it("transitions pending → confirmed and verifies in DB", async () => {
      ok(
        await kernel.services.orders.changeStatus(
          { orderId, newStatus: "confirmed" },
          admin,
        ),
      );

      const [orderRow] = await drizzle()
        .select()
        .from(orders)
        .where(eq(orders.id, orderId));
      expect(orderRow!.status).toBe("confirmed");

      const history = await drizzle()
        .select()
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, orderId));
      const confirmEntry = history.find((h) => h.toStatus === "confirmed");
      expect(confirmEntry).toBeDefined();
    });

    it("transitions confirmed → processing and verifies in DB", async () => {
      ok(
        await kernel.services.orders.changeStatus(
          { orderId, newStatus: "processing" },
          admin,
        ),
      );

      const [orderRow] = await drizzle()
        .select()
        .from(orders)
        .where(eq(orders.id, orderId));
      expect(orderRow!.status).toBe("processing");

      const history = await drizzle()
        .select()
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, orderId));
      expect(history.length).toBeGreaterThanOrEqual(3); // pending, confirmed, processing
    });

    it("transitions processing → fulfilled and verifies in DB", async () => {
      ok(
        await kernel.services.orders.changeStatus(
          { orderId, newStatus: "fulfilled" },
          admin,
        ),
      );

      const [orderRow] = await drizzle()
        .select()
        .from(orders)
        .where(eq(orders.id, orderId));
      expect(orderRow!.status).toBe("fulfilled");
      expect(orderRow!.fulfilledAt).not.toBeNull();
    });

    it("getStatusHistory returns full transition chain", async () => {
      const result = ok(await kernel.services.orders.getStatusHistory(orderId, admin));
      const statuses = result.map((h: { toStatus: string }) => h.toStatus);
      expect(statuses).toContain("pending");
      expect(statuses).toContain("confirmed");
      expect(statuses).toContain("processing");
      expect(statuses).toContain("fulfilled");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 9. ANALYTICS
  // ═══════════════════════════════════════════════════════════════════

  describe("9 — Analytics", () => {
    // Analytics queries require a scope — the engine enforces deny-by-default.
    // Admin scope sees all cubes and all rows.
    const adminScope = { role: "admin" as const };

    it("revenue query matches order grandTotal", async () => {
      const result = ok(
        await kernel.services.analytics.query({
          measures: ["Orders.revenue", "Orders.count"],
        }, adminScope),
      );
      const rows = result.rows as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      // PostgreSQL SUM/COUNT returns bigint → Drizzle serializes as string
      expect(Number(rows[0]!["Orders.revenue"])).toBe(55194);
      expect(Number(rows[0]!["Orders.count"])).toBe(1);
    });

    it("inventory value query returns data", async () => {
      const result = ok(
        await kernel.services.analytics.query({
          measures: ["Inventory.totalOnHand"],
        }, adminScope),
      );
      const rows = result.rows as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(Number(rows[0]!["Inventory.totalOnHand"])).toBeGreaterThan(0);
    });

    it("top selling items matches order line items", async () => {
      const result = ok(
        await kernel.services.analytics.query({
          measures: ["OrderLineItems.itemsSold", "OrderLineItems.lineItemRevenue"],
          dimensions: ["OrderLineItems.title"],
        }, adminScope),
      );
      const rows = result.rows as Record<string, unknown>[];
      const jacket = rows.find((r) => r["OrderLineItems.title"] === "E2E Test Jacket");
      expect(jacket).toBeDefined();
      expect(Number(jacket!["OrderLineItems.itemsSold"])).toBe(5);
      expect(Number(jacket!["OrderLineItems.lineItemRevenue"])).toBe(49995);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. CROSS-CUTTING VERIFICATION
  // ═══════════════════════════════════════════════════════════════════

  describe("10 — Cross-Cutting DB Integrity", () => {
    it("order references valid customer UUID", async () => {
      const [orderRow] = await drizzle()
        .select()
        .from(orders)
        .where(eq(orders.id, orderId));
      const [customerRow] = await drizzle()
        .select()
        .from(customers)
        .where(eq(customers.id, orderRow!.customerId!));
      expect(customerRow).toBeDefined();
      expect(customerRow!.userId).toBe("e2e-buyer");
    });

    it("order line item references valid catalog entity", async () => {
      const items = await drizzle()
        .select()
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, orderId));
      for (const item of items) {
        const [entity] = await drizzle()
          .select()
          .from(sellableEntities)
          .where(eq(sellableEntities.id, item.entityId));
        expect(entity).toBeDefined();
        expect(entity!.status).toBe("active");
      }
    });

    it("inventory level warehouse FK is valid", async () => {
      const [level] = await drizzle()
        .select()
        .from(inventoryLevels)
        .where(eq(inventoryLevels.entityId, productId));
      const [wh] = await drizzle()
        .select()
        .from(warehouses)
        .where(eq(warehouses.id, level!.warehouseId));
      expect(wh).toBeDefined();
      expect(wh!.code).toBe("E2E");
    });

    it("cart was linked to correct customer", async () => {
      const [cartRow] = await drizzle()
        .select()
        .from(carts)
        .where(eq(carts.id, cartId));
      expect(cartRow!.customerId).toBe(customerId);
    });

    it("total row counts match expected", async () => {
      const [entityCount] = await drizzle()
        .select({ count: sql<number>`count(*)::int` })
        .from(sellableEntities);
      expect(entityCount!.count).toBe(1);

      const [orderCount] = await drizzle()
        .select({ count: sql<number>`count(*)::int` })
        .from(orders);
      expect(orderCount!.count).toBe(1);

      const [cartCount] = await drizzle()
        .select({ count: sql<number>`count(*)::int` })
        .from(carts);
      expect(cartCount!.count).toBe(1);

      const [customerCount] = await drizzle()
        .select({ count: sql<number>`count(*)::int` })
        .from(customers);
      expect(customerCount!.count).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 11. LOYALTY PLUGIN (DB-backed)
  // ═══════════════════════════════════════════════════════════════════

  describe("11 — Loyalty Plugin (DB-backed)", () => {
    it("buildSchema includes plugin tables", async () => {
      const config = await configPromise;
      const merged = buildSchema(config);
      expect(merged).toHaveProperty("loyaltyPoints");
      expect(merged).toHaveProperty("loyaltyTransactions");
      // Core tables still present
      expect(merged).toHaveProperty("sellableEntities");
      expect(merged).toHaveProperty("orders");
    });

    it("order creation awarded loyalty points via hook", async () => {
      // The order created in section 7 should have triggered the loyalty hook
      const rows = await drizzle()
        .select()
        .from(loyaltyPoints)
        .where(eq(loyaltyPoints.customerId, customerId));
      const loyalty = rows[0];

      expect(loyalty).toBeDefined();
      expect(loyalty!.points).toBeGreaterThan(0);
      expect(loyalty!.tier).toBeDefined();
      expect(["bronze", "silver", "gold", "platinum"]).toContain(loyalty!.tier);
    });

    it("loyalty transaction was recorded for the order", async () => {
      const txns = await drizzle()
        .select()
        .from(loyaltyTransactions)
        .where(eq(loyaltyTransactions.customerId, customerId));

      expect(txns.length).toBeGreaterThanOrEqual(1);
      const earnTxn = txns.find((t) => t.type === "earn");
      expect(earnTxn).toBeDefined();
      expect(earnTxn!.orderId).toBe(orderId);
      expect(earnTxn!.amount).toBeGreaterThan(0);
    });

    it("loyalty points match expected calculation", async () => {
      // Order grandTotal was 55194 cents = $551.94 → floor(551.94 * 1) = 551 points
      const rows = await drizzle()
        .select()
        .from(loyaltyPoints)
        .where(eq(loyaltyPoints.customerId, customerId));
      const loyalty = rows[0]!;

      expect(loyalty.points).toBe(551);
      // 551 points >= 500 silver threshold → silver tier
      expect(loyalty.tier).toBe("silver");
    });
  });
});
