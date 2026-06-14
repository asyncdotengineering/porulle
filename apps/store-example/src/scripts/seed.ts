/**
 * Seed Script — populates the database with a realistic catalog.
 *
 * Run: bun run seed
 *
 * This uses the kernel directly (not HTTP) so it works before the server starts.
 */

import { createKernel, ensureDefaultOrg, DEFAULT_ORG_ID, type Actor } from "@porulle/core";
import configPromise from "../../commerce.config.js";

const config = await configPromise;
const kernel = createKernel(config);

const staff: Actor = {
  type: "user",
  userId: "seed-admin",
  email: "admin@acme-streetwear.com",
  name: "Seed Admin",
  vendorId: null,
  organizationId: DEFAULT_ORG_ID,
  role: "owner",
  permissions: ["*:*"],
};

async function seed() {
  await ensureDefaultOrg(kernel.database.db);

  console.log("🌱 Seeding Acme Streetwear store...\n");

  // ─── Categories ──────────────────────────────────────────────────
  console.log("Creating categories...");
  const tops = await kernel.services.catalog.createCategory(
    { slug: "tops" },
    staff,
  );
  const bottoms = await kernel.services.catalog.createCategory(
    { slug: "bottoms" },
    staff,
  );
  const accessories = await kernel.services.catalog.createCategory(
    { slug: "accessories" },
    staff,
  );
  if (!tops.ok || !bottoms.ok || !accessories.ok) {
    console.error("Failed to create categories:", {
      tops,
      bottoms,
      accessories,
    });
    process.exit(1);
  }
  console.log(
    `  ✓ ${tops.value.slug}, ${bottoms.value.slug}, ${accessories.value.slug}`,
  );

  // ─── Brands ──────────────────────────────────────────────────────
  console.log("Creating brands...");
  const acmeBrand = await kernel.services.catalog.createBrand(
    { displayName: "Acme Originals", slug: "acme-originals" },
    staff,
  );
  const collab = await kernel.services.catalog.createBrand(
    { displayName: "Street Collab", slug: "street-collab" },
    staff,
  );
  if (!acmeBrand.ok || !collab.ok) {
    console.error("Failed to create brands");
    process.exit(1);
  }
  console.log(
    `  ✓ ${acmeBrand.value.displayName}, ${collab.value.displayName}`,
  );

  // ─── Warehouse ───────────────────────────────────────────────────
  console.log("Creating warehouses...");
  const mainWarehouse = await kernel.services.inventory.createWarehouse({
    name: "Main Warehouse",
    code: "MAIN",
  }, staff);
  const popupWarehouse = await kernel.services.inventory.createWarehouse({
    name: "Pop-up Store",
    code: "POPUP",
  }, staff);
  if (!mainWarehouse.ok || !popupWarehouse.ok) {
    console.error("Failed to create warehouses");
    process.exit(1);
  }
  console.log(
    `  ✓ ${mainWarehouse.value.name} (${mainWarehouse.value.code}), ${popupWarehouse.value.name} (${popupWarehouse.value.code})`,
  );

  // ─── Products ────────────────────────────────────────────────────
  console.log("Creating products...\n");

  const products = [
    {
      slug: "classic-tee",
      title: "Classic Logo Tee",
      description: "Our signature 100% organic cotton tee with the Acme logo.",
      metadata: { basePrice: 2999, weight: 200, material: "Organic Cotton" },
      category: tops.value.id,
      brand: acmeBrand.value.id,
      stock: 50,
      unitCost: 800,
    },
    {
      slug: "oversized-hoodie",
      title: "Oversized Hoodie",
      description: "Relaxed fit heavyweight hoodie. 80% cotton, 20% polyester.",
      metadata: { basePrice: 7999, weight: 650, material: "Cotton Blend" },
      category: tops.value.id,
      brand: acmeBrand.value.id,
      stock: 30,
      unitCost: 2200,
    },
    {
      slug: "cargo-pants",
      title: "Urban Cargo Pants",
      description: "Utility-inspired cargo pants with six pockets.",
      metadata: { basePrice: 6499, weight: 500, material: "Ripstop Nylon" },
      category: bottoms.value.id,
      brand: collab.value.id,
      stock: 40,
      unitCost: 1800,
    },
    {
      slug: "beanie-knit",
      title: "Knit Beanie",
      description: "Ribbed knit beanie in multiple colorways.",
      metadata: { basePrice: 1999, weight: 80, material: "Merino Wool" },
      category: accessories.value.id,
      brand: acmeBrand.value.id,
      stock: 100,
      unitCost: 400,
    },
    {
      slug: "crossbody-bag",
      title: "Crossbody Sling Bag",
      description: "Compact sling bag with waterproof coating.",
      metadata: { basePrice: 4499, weight: 300, material: "Cordura Nylon" },
      category: accessories.value.id,
      brand: collab.value.id,
      stock: 25,
      unitCost: 1200,
    },
  ];

  for (const p of products) {
    // Create entity
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: p.slug,
        attributes: {
          title: p.title,
          description: p.description,
        },
        metadata: p.metadata,
      },
      staff,
    );
    if (!entity.ok) {
      console.error(`  ✗ Failed to create ${p.slug}:`, entity.error);
      continue;
    }

    // Publish
    await kernel.services.catalog.publish(entity.value.id, staff);

    // Add to category + brand
    await kernel.services.catalog.addToCategory(entity.value.id, p.category, staff);
    await kernel.services.catalog.addToBrand(entity.value.id, p.brand, staff);

    // Set price
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: p.metadata.basePrice,
    }, staff);

    // Stock at main warehouse
    await kernel.services.inventory.adjust(
      {
        entityId: entity.value.id,
        warehouseId: mainWarehouse.value.id,
        adjustment: p.stock,
        reason: "initial_stock",
      },
      staff,
    );

    // Set unit cost for COGS tracking
    await kernel.services.inventory.setUnitCost(
      entity.value.id,
      mainWarehouse.value.id,
      p.unitCost,
    );

    // Small stock at popup
    await kernel.services.inventory.adjust(
      {
        entityId: entity.value.id,
        warehouseId: popupWarehouse.value.id,
        adjustment: Math.floor(p.stock / 5),
        reason: "popup_allocation",
      },
      staff,
    );

    console.log(
      `  ✓ ${p.title.padEnd(28)} $${(p.metadata.basePrice / 100).toFixed(2).padStart(7)}  stock: ${String(p.stock).padStart(3)} (main) + ${String(Math.floor(p.stock / 5)).padStart(2)} (popup)`,
    );
  }

  // ─── Gift Card ───────────────────────────────────────────────────
  console.log("\nCreating gift card...");
  const giftCard = await kernel.services.catalog.create(
    {
      type: "gift_card",
      slug: "digital-gift-card",
      attributes: {
        title: "Acme Gift Card",
        description: "Send the gift of streetwear. Delivered via email.",
      },
      metadata: { denomination: 5000 },
    },
    staff,
  );
  if (giftCard.ok) {
    await kernel.services.catalog.publish(giftCard.value.id, staff);
    await kernel.services.pricing.setBasePrice({
      entityId: giftCard.value.id,
      currency: "USD",
      amount: 5000,
    }, staff);
    console.log(`  ✓ Acme Gift Card  $50.00`);
  }

  // ─── Customer ────────────────────────────────────────────────────
  console.log("\nCreating sample customer...");
  // getByUserId auto-creates the customer record, then we update with details
  const customerBase =
    await kernel.services.customers.getByUserId("customer-jane", staff);
  if (customerBase.ok) {
    const customer = await kernel.services.customers.updateByUserId(
      "customer-jane",
      {
        email: "jane@example.com",
        firstName: "Jane",
        lastName: "Doe",
      },
      staff,
    );
    if (customer.ok) {
      console.log(
        `  ✓ ${customer.value.firstName} ${customer.value.lastName} (${customer.value.email})`,
      );
    }
  }

  // ─── Promotion ───────────────────────────────────────────────────
  console.log("\nCreating promotions...");
  const promo = await kernel.services.promotions.create({
    name: "WELCOME10",
    code: "WELCOME10",
    type: "percentage_off_order",
    value: 10,
    isActive: true,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
  }, staff);
  if (promo.ok) {
    console.log(`  ✓ ${promo.value.code} — 10% off (valid 90 days)`);
  }

  console.log("\n✅ Seed complete! Run 'bun run dev' to start the server.\n");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
