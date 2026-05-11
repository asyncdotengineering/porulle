/**
 * SaaS Example Seed Script
 *
 * Demonstrates multi-tenant commerce: two stores on one UC instance,
 * each with its own catalog, pricing, inventory, and promotions.
 * Data is fully isolated between organizations.
 *
 * Run: bun run seed
 */

import {
  createKernel,
  ensureDefaultOrg,
} from "@porulle/core";
import { sql } from "@porulle/core/drizzle";
import configPromise from "../../commerce.config.js";

const config = await configPromise;
const kernel = createKernel(config);
const db = kernel.database.db as import("@porulle/core/drizzle").PgDatabase<import("@porulle/core/drizzle").PgQueryResultHKT>;

interface Result<T> { ok: true; value: T }
interface ResultErr { ok: false; error: unknown }

function ok<T>(result: Result<T> | ResultErr): T {
  if (!result.ok) throw new Error(`Seed failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

// ─── Create Organizations ─────────────────────────────────────────────

console.log("=== UnifiedCommerce SaaS Example ===\n");

await ensureDefaultOrg(db);

const ORG_ALPHA = "org_alpha";
const ORG_BETA = "org_beta";

// Create orgs via raw SQL (avoids needing to import auth-schema)
await db.execute(sql`
  INSERT INTO organization (id, name, slug, created_at)
  VALUES (${ORG_ALPHA}, 'Alpha Streetwear', 'alpha-streetwear', NOW())
  ON CONFLICT (id) DO NOTHING
`);
await db.execute(sql`
  INSERT INTO organization (id, name, slug, created_at)
  VALUES (${ORG_BETA}, 'Beta Organics', 'beta-organics', NOW())
  ON CONFLICT (id) DO NOTHING
`);

console.log("Organizations created:");
console.log("  - Alpha Streetwear (org_alpha) -- urban fashion");
console.log("  - Beta Organics (org_beta) -- organic food\n");

// ─── Actor Definitions ────────────────────────────────────────────────

const alphaAdmin = {
  type: "user" as const,
  userId: "alpha-admin",
  email: "admin@alpha-streetwear.com",
  name: "Alpha Admin",
  vendorId: null,
  organizationId: ORG_ALPHA,
  role: "admin",
  permissions: ["*:*"],
};

const betaAdmin = {
  type: "user" as const,
  userId: "beta-admin",
  email: "admin@beta-organics.com",
  name: "Beta Admin",
  vendorId: null,
  organizationId: ORG_BETA,
  role: "admin",
  permissions: ["*:*"],
};

// ─── Helper ───────────────────────────────────────────────────────────

type Entity = { id: string; slug: string };

async function seedStore(
  admin: typeof alphaAdmin,
  storeName: string,
  categories: Array<{ slug: string; title: string }>,
  warehouse: { name: string; code: string },
  products: Array<{ slug: string; title: string; price: number }>,
  promo: { code: string; name: string; value: number },
) {
  console.log(`Seeding ${storeName}...`);

  for (const cat of categories) {
    ok(await kernel.services.catalog.createCategory(
      { slug: cat.slug, metadata: { title: cat.title } },
      admin,
    ));
  }

  await kernel.services.inventory.createWarehouse(warehouse, admin);

  for (const p of products) {
    const entity = ok(await kernel.services.catalog.create(
      { type: "product", slug: p.slug, metadata: {} },
      admin,
    )) as Entity;

    await kernel.services.catalog.setAttributes(entity.id, "en", {
      title: p.title,
      description: `${p.title} from ${storeName}.`,
    }, admin);

    await kernel.services.pricing.setBasePrice({
      entityId: entity.id,
      currency: "USD",
      amount: p.price,
    }, admin);

    await kernel.services.inventory.adjust(
      { entityId: entity.id, adjustment: 50, reason: "Initial stock" },
      admin,
    );

    ok(await kernel.services.catalog.publish(entity.id, admin));
    console.log(`  + ${p.title.padEnd(25)} $${(p.price / 100).toFixed(2)}`);
  }

  ok(await kernel.services.promotions.create({
    code: promo.code,
    name: promo.name,
    type: "percentage_off_order",
    value: promo.value,
    isActive: true,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  }, admin));
  console.log(`  + Promo: ${promo.code} (${promo.value}% off)\n`);
}

// ─── Seed Alpha Streetwear ────────────────────────────────────────────

await seedStore(
  alphaAdmin,
  "Alpha Streetwear",
  [
    { slug: "tops", title: "Tops" },
    { slug: "bottoms", title: "Bottoms" },
  ],
  { name: "Alpha Warehouse NYC", code: "NYC-01" },
  [
    // Note: "summer-special" slug exists in BOTH orgs
    { slug: "summer-special", title: "Summer Street Tee", price: 3500 },
    { slug: "urban-hoodie", title: "Urban Hoodie", price: 7500 },
    { slug: "cargo-pants", title: "Cargo Pants", price: 6000 },
  ],
  { code: "ALPHA10", name: "Alpha 10% Off", value: 10 },
);

// ─── Seed Beta Organics ───────────────────────────────────────────────

await seedStore(
  betaAdmin,
  "Beta Organics",
  [
    { slug: "produce", title: "Fresh Produce" },
    { slug: "dairy", title: "Dairy" },
  ],
  { name: "Beta Cold Storage LA", code: "LA-COLD" },
  [
    // Same slug "summer-special" — composite unique allows this
    { slug: "summer-special", title: "Summer Berry Box", price: 1200 },
    { slug: "organic-milk", title: "Organic Whole Milk", price: 650 },
    { slug: "avocado-pack", title: "Avocado 4-Pack", price: 800 },
  ],
  { code: "BETA15", name: "Beta 15% Off", value: 15 },
);

// ─── Isolation Verification ───────────────────────────────────────────

console.log("=== Isolation Verification ===\n");

const alphaCtx = { tx: undefined as unknown, actor: alphaAdmin, requestId: "verify" };
const betaCtx = { tx: undefined as unknown, actor: betaAdmin, requestId: "verify" };

const alphaList = await kernel.services.catalog.list({ filter: {} }, alphaAdmin, alphaCtx);
const betaList = await kernel.services.catalog.list({ filter: {} }, betaAdmin, betaCtx);

if (alphaList.ok && betaList.ok) {
  const alphaSlugs = alphaList.value.items.map((e: Entity) => e.slug);
  const betaSlugs = betaList.value.items.map((e: Entity) => e.slug);

  console.log(`Alpha sees ${alphaList.value.items.length} products: ${alphaSlugs.join(", ")}`);
  console.log(`Beta sees ${betaList.value.items.length} products: ${betaSlugs.join(", ")}`);

  // Verify no cross-org leaks
  const alphaHasOnlyAlpha = alphaSlugs.every(
    (s: string) => ["summer-special", "urban-hoodie", "cargo-pants"].includes(s),
  );
  const betaHasOnlyBeta = betaSlugs.every(
    (s: string) => ["summer-special", "organic-milk", "avocado-pack"].includes(s),
  );

  console.log(`\nAlpha data isolated: ${alphaHasOnlyAlpha ? "YES" : "NO (BUG!)"}`);
  console.log(`Beta data isolated: ${betaHasOnlyBeta ? "YES" : "NO (BUG!)"}`);

  // Both have "summer-special" but different entity IDs
  const alphaSummer = alphaList.value.items.find((e: Entity) => e.slug === "summer-special");
  const betaSummer = betaList.value.items.find((e: Entity) => e.slug === "summer-special");
  if (alphaSummer && betaSummer) {
    console.log(`Both have "summer-special" with different IDs: ${alphaSummer.id !== betaSummer.id ? "YES" : "NO (BUG!)"}`);
  }
}

console.log("\nSeed complete. Run 'bun run dev' to start the SaaS platform.\n");
process.exit(0);
