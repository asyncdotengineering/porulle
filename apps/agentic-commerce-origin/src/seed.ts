import { postgresAdapter } from "@porulle/adapter-postgres";
import { createCommerce, createSystemActor, ensureDefaultOrg, type Kernel } from "@porulle/core";
import { createOriginConfig } from "../commerce.config.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://localhost:5432/kuralle_agentic_commerce";
const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:4000";
const config = await createOriginConfig({
  DATABASE_URL: databaseUrl,
  PUBLIC_URL: publicUrl,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
  ...(process.env.STRIPE_WEBHOOK_SECRET ? { STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET } : {}),
}, postgresAdapter({ connectionString: databaseUrl, pool: { max: 2, idleTimeout: 1 } }));
const commerce = await createCommerce(config);
await ensureDefaultOrg(commerce.kernel.database.db, config.storeName);
const actor = createSystemActor("org_default");

type ProductSeed = {
  slug: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  price: number;
  stock: number;
};

const products: ProductSeed[] = [
  {
    slug: "trail-pack-18l",
    title: "Trail Pack 18L",
    description: "A weatherproof recycled-nylon daypack with a padded laptop sleeve and low-profile trail straps.",
    brand: "Field Notes Supply",
    category: "bags",
    price: 9900,
    stock: 14,
  },
  {
    slug: "commuter-tote",
    title: "Commuter Tote",
    description: "A structured canvas tote with a zip top, bottle pocket, and removable cross-body strap.",
    brand: "Northline",
    category: "bags",
    price: 7400,
    stock: 9,
  },
  {
    slug: "studio-bottle-750",
    title: "Studio Bottle 750",
    description: "A vacuum-insulated stainless bottle sized for a workday, with a leakproof twist cap.",
    brand: "Common Vessel",
    category: "drinkware",
    price: 3200,
    stock: 22,
  },
  {
    slug: "field-blanket",
    title: "Field Blanket",
    description: "A washable wool-blend picnic blanket with a water-resistant base and carry straps.",
    brand: "Field Notes Supply",
    category: "outdoors",
    price: 12800,
    stock: 6,
  },
];

function unwrap<T>(result: { ok: boolean; value?: T; error?: unknown }, operation: string): T {
  if (!result.ok) throw result.error instanceof Error ? result.error : new Error(`${operation} failed`);
  return result.value as T;
}

async function upsertProduct(kernel: Kernel, seed: ProductSeed): Promise<string> {
  const existing = await kernel.services.catalog.getBySlug(seed.slug, { includeAttributes: true }, actor);
  const entity = existing.ok
    ? unwrap(await kernel.services.catalog.update(existing.value.id, {
        metadata: { brand: seed.brand, category: seed.category, productUrl: `${publicUrl}/products/${seed.slug}` },
      }, actor), `update ${seed.slug}`)
    : unwrap(await kernel.services.catalog.create({
        type: "product",
        slug: seed.slug,
        attributes: { locale: "en", title: seed.title, description: seed.description },
        metadata: { brand: seed.brand, category: seed.category, productUrl: `${publicUrl}/products/${seed.slug}` },
      }, actor), `create ${seed.slug}`);

  unwrap(await kernel.services.catalog.setAttributes(entity.id, "en", {
    title: seed.title,
    description: seed.description,
  }, actor), `set attributes for ${seed.slug}`);
  if (entity.status !== "active") unwrap(await kernel.services.catalog.publish(entity.id, actor), `publish ${seed.slug}`);
  unwrap(await kernel.services.pricing.setBasePrice({
    entityId: entity.id,
    currency: "USD",
    amount: seed.price,
  }, actor), `price ${seed.slug}`);
  unwrap(await kernel.services.inventory.adjust({
    entityId: entity.id,
    mode: "set",
    amount: seed.stock,
    reason: "agentic-commerce seed",
  }, actor), `stock ${seed.slug}`);
  return entity.id;
}

const warehouses = unwrap(await commerce.kernel.services.inventory.listWarehouses(actor), "list warehouses");
if (!warehouses.some((warehouse) => warehouse.code === "MAIN")) {
  unwrap(await commerce.kernel.services.inventory.createWarehouse({
    name: "Main Warehouse",
    code: "MAIN",
    priority: 0,
  }, actor), "create warehouse");
}

const productIds: string[] = [];
for (const product of products) productIds.push(await upsertProduct(commerce.kernel, product));

const createdKey = await commerce.auth.api.createApiKey({
  body: {
    configId: "agent_storefront",
    userId: "agentic-commerce-assistant",
    name: "Agentic Commerce Assistant",
    permissions: config.auth?.apiKeyScopes?.agent_storefront?.permissions,
  },
});

// Machine-readable so automation can capture the credential without scraping logs.
// Treat stdout as a secret when invoking this script.
console.log(JSON.stringify({ products: productIds, storefrontKey: createdKey.key }));
