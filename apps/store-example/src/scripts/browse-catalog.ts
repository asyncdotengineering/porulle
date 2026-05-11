/**
 * Demo: Browse the catalog via REST API.
 *
 * Run: bun run demo:browse  (server must be running)
 */

import { api, log, heading } from "./_helpers.js";

async function main() {
  heading("BROWSE CATALOG");

  // ─── List all products ───────────────────────────────────────────
  const catalog = await api<{ data: Record<string, any>[]; meta: Record<string, any> }>(
    "GET",
    "/api/catalog/entities?type=product&include=categories,brands",
  );
  log("All Products", {
    count: catalog.data.length,
    products: catalog.data.map((p: Record<string, any>) => ({
      id: p.id,
      slug: p.slug,
      status: p.status,
      price: p.metadata?.basePrice
        ? `$${(p.metadata.basePrice / 100).toFixed(2)}`
        : "N/A",
    })),
  });

  // ─── Get a single product by ID ──────────────────────────────────
  if (catalog.data.length > 0) {
    const first = catalog.data[0]!;
    const detail = await api<{ data: Record<string, any> }>(
      "GET",
      `/api/catalog/entities/${first.id}?include=attributes,variants,categories,brands`,
    );
    log(`Product Detail: ${first.slug}`, detail.data);
  }

  // ─── List categories ─────────────────────────────────────────────
  const categories = await api<{ data: Record<string, any>[] }>(
    "GET",
    "/api/catalog/categories",
  );
  log("Categories", categories.data);

  // ─── List brands ─────────────────────────────────────────────────
  const brands = await api<{ data: Record<string, any>[] }>("GET", "/api/catalog/brands");
  log("Brands", brands.data);

  // ─── Search ──────────────────────────────────────────────────────
  const search = await api<{ data: Record<string, any> }>("GET", "/api/search?q=hoodie");
  log("Search: 'hoodie'", search);

  console.log("\n✅ Catalog browse complete.\n");
}

main().catch(console.error);
