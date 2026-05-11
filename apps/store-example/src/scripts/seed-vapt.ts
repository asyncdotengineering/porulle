/**
 * VAPT seed — creates two tenants with overlapping resources so
 * cross-tenant probes have something to attack. Idempotent.
 *
 * Run via fly mpg proxy:
 *   DATABASE_URL=postgres://... bun src/scripts/seed-vapt.ts
 */

import { createKernel, type Actor } from "@porulle/core";
import { organization } from "@porulle/core/auth-schema";
import configPromise from "../../commerce.config.js";

const config = await configPromise;
const kernel = createKernel(config);

const ORG_A = "org_a";
const ORG_B = "org_b";

function makeAdmin(orgId: string, suffix: string): Actor {
  return {
    type: "user",
    userId: `vapt-admin-${suffix}`,
    email: `admin-${suffix}@vapt.test`,
    name: `Admin ${suffix.toUpperCase()}`,
    vendorId: null,
    organizationId: orgId,
    role: "owner",
    permissions: ["*:*"],
  };
}

const adminA = makeAdmin(ORG_A, "a");
const adminB = makeAdmin(ORG_B, "b");

async function seedOrg(orgId: string, name: string, slug: string, admin: Actor) {
  console.log(`\n=== Seeding ${orgId} ===`);

  const db = kernel.database.db as {
    insert: (t: unknown) => {
      values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> };
    };
  };
  await db
    .insert(organization)
    .values({ id: orgId, name, slug, createdAt: new Date() })
    .onConflictDoNothing();
  console.log(`  ✓ org row`);

  const cat = await kernel.services.catalog.createCategory(
    { slug: `${slug}-shirts` },
    admin,
  );
  if (!cat.ok && !String(cat.error.message ?? "").includes("already exists")) {
    console.error("  ✗ category:", cat.error);
    process.exit(1);
  }
  const catId = cat.ok ? cat.value.id : "(existing)";
  console.log(`  ✓ category ${catId}`);

  const product = await kernel.services.catalog.create(
    {
      type: "product",
      slug: `${slug}-tee-001`,
      attributes: { title: `${name} Tee`, description: "VAPT seed product" },
      metadata: {},
    },
    admin,
  );
  if (!product.ok && !String(product.error.message ?? "").includes("already exists")) {
    console.error("  ✗ product:", product.error);
    process.exit(1);
  }
  const productId = product.ok ? product.value.id : "(existing)";
  console.log(`  ✓ product ${productId}`);

  const wh = await kernel.services.inventory.createWarehouse(
    { name: `${name} Warehouse`, code: `${slug.toUpperCase()}-WH` },
    admin,
  );
  if (!wh.ok && !String(wh.error.message ?? "").includes("already exists")) {
    console.error("  ✗ warehouse:", wh.error);
    process.exit(1);
  }
  const whId = wh.ok ? wh.value.id : "(existing)";
  console.log(`  ✓ warehouse ${whId}`);

  return { orgId, catId, productId, whId };
}

async function main() {
  const a = await seedOrg(ORG_A, "Tenant Alpha", "alpha", adminA);
  const b = await seedOrg(ORG_B, "Tenant Bravo", "bravo", adminB);

  console.log("\n=== VAPT seed complete ===");
  console.log(JSON.stringify({ a, b }, null, 2));
  console.log("\nProbe targets:");
  console.log(`  ORG_A entity for B-admin to attack: ${a.productId}`);
  console.log(`  ORG_B entity for A-admin to attack: ${b.productId}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("seed failed:", e);
  process.exit(1);
});
