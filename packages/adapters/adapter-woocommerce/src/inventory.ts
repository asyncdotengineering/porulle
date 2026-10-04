import { Ok } from "@porulle/core";
import type { ChannelConnectorError, ChannelInventoryLevel, Result } from "@porulle/core";
import { z } from "zod";
import { isPurchasable, wooProductSchema, wooVariationSchema } from "./catalog.js";
import type { WooProduct, WooVariation } from "./catalog.js";
import type { WooClient } from "./client.js";

/**
 * Sellable stock of one product or variation. A store that tracks quantity says how many (a variation
 * whose stock is its parent's, `manage_stock: "parent"`, already reports the parent's count); one that
 * does not (`manage_stock: false`) only says in or out of stock, and "in stock" is read as `untracked`
 * units so a shopper can buy it. Never negative: an oversold item reads as none.
 */
export function available(row: Pick<WooVariation, "manage_stock" | "stock_quantity" | "stock_status">, untracked: number): number {
  if (row.manage_stock === true || row.manage_stock === "parent") return Math.max(0, Math.floor(row.stock_quantity ?? 0));
  return row.stock_status === "instock" || row.stock_status === "onbackorder" ? untracked : 0;
}

/** Levels for one page of products: a simple product by its own id, a variable one per variation. */
async function levelsOf(client: WooClient, products: WooProduct[], untracked: number): Promise<Result<ChannelInventoryLevel[], ChannelConnectorError>> {
  const levels: ChannelInventoryLevel[] = [];
  for (const product of products) {
    if (!isPurchasable(product)) continue;
    if (product.type === "simple") {
      levels.push({ externalId: product.id, available: available(product, untracked) });
      continue;
    }
    if (product.variations.length === 0) continue;
    const variations = await client.all(`/wc/v3/products/${encodeURIComponent(product.id)}/variations`, wooVariationSchema);
    if (!variations.ok) return variations;
    for (const variation of variations.value) levels.push({ externalId: variation.id, available: available(variation, untracked) });
  }
  return Ok(levels);
}

const pageCursor = z.coerce.number().int().positive();

/** One page of products (and their variations), with the next page's cursor or null on the last. */
export async function inventoryPage(client: WooClient, cursor: string | null, untracked: number): Promise<Result<{ levels: ChannelInventoryLevel[]; nextCursor: string | null }, ChannelConnectorError>> {
  const page = cursor === null ? 1 : pageCursor.catch(1).parse(cursor);
  const read = await client.get("/wc/v3/products", z.array(wooProductSchema), { per_page: "50", page: String(page), orderby: "id", order: "asc" });
  if (!read.ok) return read;
  const levels = await levelsOf(client, read.value.data, untracked);
  if (!levels.ok) return levels;
  return Ok({ levels: levels.value, nextCursor: page < read.value.totalPages ? String(page + 1) : null });
}

/**
 * Levels for the named ids, each a simple product's id or a variation's (the ids every order line and
 * stock check carries). A variation is found through its parent; an id the store no longer has is
 * absent, which the caller treats as unconfirmed.
 */
export async function inventoryFor(client: WooClient, ids: string[], untracked: number): Promise<Result<ChannelInventoryLevel[], ChannelConnectorError>> {
  if (ids.length === 0) return Ok([]);
  const wanted = new Set(ids);
  const levels: ChannelInventoryLevel[] = [];
  // Simple products answer by their own id; whatever is left must be a variation.
  const products = await client.all("/wc/v3/products", wooProductSchema, { include: ids.join(","), status: "any" });
  if (!products.ok) return products;
  for (const product of products.value) {
    if (product.type === "simple" && wanted.has(product.id)) {
      levels.push({ externalId: product.id, available: available(product, untracked) });
      wanted.delete(product.id);
    }
  }
  // A variation is a product too: `/products/{id}` answers it by its own id.
  for (const variationId of wanted) {
    const read = await client.get(`/wc/v3/products/${encodeURIComponent(variationId)}`, wooVariationSchema);
    if (!read.ok) {
      if (read.error.status === 404) continue;
      return read;
    }
    levels.push({ externalId: read.value.data.id, available: available(read.value.data, untracked) });
  }
  return Ok(levels);
}
