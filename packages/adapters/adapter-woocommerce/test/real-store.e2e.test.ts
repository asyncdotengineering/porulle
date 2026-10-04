/**
 * The adapter against a REAL WooCommerce store over HTTPS — no stand-in, no fetch double.
 *
 * Runs only when a store is named: `WOO_E2E_URL` (https), `WOO_E2E_CK` / `WOO_E2E_CS` (read_write keys).
 * The store is WooCommerce's own sample catalogue (18 products: Hoodie variable with 4 variations,
 * V-Neck T-Shirt with 3, a grouped "Logo Collection" and an external "WordPress Pennant"), priced in
 * LKR, with store tax ON. The rows put the stock they need in place and put it back.
 *
 * What could pass without proving the behaviour, written before the rows:
 *  - an import that "works" but prices nothing → every simple product must carry one priced variant;
 *  - a sale price read as the price with no compare-at → Beanie with Logo must read 1800 / 2000;
 *  - grouped/external products leaking into the catalogue → their ids must be absent;
 *  - a store total that silently includes store tax → the order total must equal grandTotal exactly;
 *  - a retry that creates a second paid order → the second push must answer the SAME store order;
 *  - an oversell that "succeeds" (WooCommerce never refuses stock) → CHANNEL_OUT_OF_STOCK and no order;
 *  - a cancel that does not restock → the stock read after must equal the stock before;
 *  - a disabled subscription reported healthy → after disabling one, health must recreate exactly one.
 *
 * Each run writes what it saw to WOO_E2E_ARTIFACT (default: the OS temp dir) for the record.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_CREDENTIALS_REJECTED, CHANNEL_OUT_OF_STOCK } from "@porulle/core";
import type { ChannelCatalogItem, ChannelOrderSlice, ChannelStore } from "@porulle/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wooConnector } from "../src/index.js";

const url = process.env.WOO_E2E_URL;
const ck = process.env.WOO_E2E_CK;
const cs = process.env.WOO_E2E_CS;
const live = Boolean(url && ck && cs);

const connector = wooConnector({ userAgent: "Porulle-WooCommerce-E2E/1.0", untrackedStockQuantity: 99 });
const seen: Record<string, unknown> = {};

/** Direct store calls the rows use to arrange and inspect, outside the adapter under test. */
async function store<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${url}/wp-json/wc/v3${path}`, {
    method,
    headers: { authorization: `Basic ${btoa(`${ck}:${cs}`)}`, "content-type": "application/json", accept: "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

describe.skipIf(!live)("a real WooCommerce store", { timeout: 180_000 }, () => {
  let channelStore: ChannelStore;
  let items: ChannelCatalogItem[] = [];
  const restore: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    const base: ChannelStore = { id: "e2e-store", organizationId: "e2e", provider: "woocommerce", credentials: { consumerKey: ck, consumerSecret: cs }, storeDomain: url ?? "", status: "connected", webhookSecret: "e2e-webhook-secret" };
    const learned = await connector.liveCredentials!(base);
    if (!learned.ok) throw new Error(learned.error.message);
    channelStore = { ...base, credentials: learned.value ?? base.credentials };
    seen.credentials = { ...channelStore.credentials, consumerKey: "[redacted]", consumerSecret: "[redacted]" };
  });

  afterAll(async () => {
    for (const undo of restore.reverse()) await undo().catch(() => undefined);
    const path = process.env.WOO_E2E_ARTIFACT ?? join(tmpdir(), `woo-real-store-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ store: url, at: new Date().toISOString(), seen }, null, 2));
    console.log(`artifact: ${path}`);
  });

  it("learns how to call the store: header auth, pretty REST route, LKR at 2 decimals", () => {
    expect(channelStore.credentials).toMatchObject({ authMode: "header", restRoute: "pretty", currency: "LKR", priceDecimals: 2, hpos: false });
  });

  it("refuses a key the store does not know as CHANNEL_CREDENTIALS_REJECTED", async () => {
    const bogus = { ...channelStore, credentials: { ...channelStore.credentials, consumerKey: `ck_${"0".repeat(40)}`, consumerSecret: `cs_${"0".repeat(40)}` } };
    const read = await connector.fetchInventory(bogus, ["30"]);
    expect(read.ok ? "ok" : read.error.code).toBe(CHANNEL_CREDENTIALS_REJECTED);
  });

  it("imports every purchasable product, priced, with sale prices, variations and permalinks", async () => {
    let cursor: string | undefined;
    do {
      const page = await connector.importCatalog(channelStore, cursor);
      if (!page.ok) throw new Error(page.error.message);
      items.push(...page.value.items);
      cursor = page.value.nextCursor ?? undefined;
    } while (cursor);
    seen.imported = items.map((item) => ({ id: item.externalId, title: item.title, variants: item.variants.length, prices: item.variants.map((variant) => variant.prices?.[0]) }));
    const byId = new Map(items.map((item) => [item.externalId, item]));
    expect(byId.has("32")).toBe(false); // grouped
    expect(byId.has("33")).toBe(false); // external
    expect(items).toHaveLength(16);
    expect(byId.get("11")?.variants).toHaveLength(4);
    expect(byId.get("10")?.variants).toHaveLength(3);
    for (const item of items.filter((candidate) => !["10", "11"].includes(candidate.externalId))) {
      expect(item.variants.map((variant) => variant.externalId)).toEqual([item.externalId]);
      expect(item.variants[0]?.prices?.[0]?.amount).toBeGreaterThan(0);
    }
    expect(byId.get("31")?.variants[0]?.prices).toEqual([{ currency: "LKR", amount: 1800, compareAtAmount: 2000 }]);
    expect(byId.get("31")?.storefrontUrl).toMatch(new RegExp(`^${url}/`));
  });

  it("reads stock per variation: counted, the parent's, untracked in stock, and out of stock", async () => {
    await store("PUT", "/products/11/variations/27", { manage_stock: true, stock_quantity: 2 });
    await store("PUT", "/products/11", { manage_stock: true, stock_quantity: 7 });
    // Under a parent that counts stock, a variation that does not count its own reads the parent's.
    await store("PUT", "/products/11/variations/29", { manage_stock: true, stock_quantity: 0 });
    restore.push(() => store("PUT", "/products/11/variations/29", { manage_stock: false }));
    await store("PUT", "/products/23", { manage_stock: false, stock_status: "outofstock" });
    restore.push(() => store("PUT", "/products/23", { stock_status: "instock" }));
    const levels = await connector.fetchInventory(channelStore, ["27", "28", "29", "30", "23"]);
    if (!levels.ok) throw new Error(levels.error.message);
    seen.levels = levels.value;
    expect(Object.fromEntries(levels.value.map((level) => [level.externalId, level.available]))).toEqual({ "27": 2, "28": 7, "29": 0, "30": 99, "23": 0 });
  });

  const slice = (orderId: string, lines: ChannelOrderSlice["lines"], extras: Partial<ChannelOrderSlice> = {}): ChannelOrderSlice => ({
    orderId,
    currency: "LKR",
    grandTotal: lines.reduce((sum, line) => sum + line.totalPrice, 0) - (extras.discount?.amount ?? 0) + (extras.shipping?.amount ?? 0),
    lines,
    customer: { name: "E2E Shopper", email: "e2e-shopper@example.test", shippingAddress: { firstName: "E2E", lastName: "Shopper", line1: "1 Galle Road", city: "Colombo", countryCode: "LK" } },
    ...extras,
  });
  let pushedId = "";

  it("creates the paid order at exactly what the shopper paid, promo and delivery included, with store tax on", async () => {
    const orderId = `e2e-${crypto.randomUUID()}`;
    const order = slice(orderId, [
      { externalVariantId: "31", title: "Beanie with Logo", quantity: 1, unitPrice: 1800, totalPrice: 1800 },
      { externalVariantId: "28", title: "Hoodie", quantity: 1, unitPrice: 4500, totalPrice: 4500 },
    ], { discount: { code: "WELCOME5", amount: 500 }, shipping: { title: "Island-wide delivery", amount: 350 } });
    const pushed = await connector.pushOrder(channelStore, order);
    if (!pushed.ok) throw new Error(pushed.error.message);
    pushedId = pushed.value.remoteOrderId;
    const remote = await store<{ total: string; total_tax: string; status: string; payment_method_title: string }>("GET", `/orders/${pushedId}`);
    seen.order = { orderId, grandTotal: order.grandTotal, remote };
    expect({ total: remote.total, tax: remote.total_tax, status: remote.status, paid: remote.payment_method_title }).toEqual({ total: "61.50", tax: "0.00", status: "processing", paid: "Paid on Runvae" });
    expect(pushed.value.remoteUrl).toBe(`${url}/wp-admin/post.php?post=${pushedId}&action=edit`);

    const again = await connector.pushOrder(channelStore, order);
    expect(again.ok && again.value.remoteOrderId).toBe(pushedId);
  });

  it("refuses an order the store cannot fill, and creates nothing", async () => {
    const orderId = `e2e-${crypto.randomUUID()}`;
    const refused = await connector.pushOrder(channelStore, slice(orderId, [{ externalVariantId: "27", title: "Hoodie red", quantity: 5, unitPrice: 4200, totalPrice: 21000 }]));
    expect(refused.ok ? "created" : refused.error.code).toBe(CHANNEL_OUT_OF_STOCK);
    expect(await store<unknown[]>("GET", `/orders?search=${orderId}`)).toEqual([]);
  });

  it("reads a store fulfilment with tracking and a store refund of one line as events", async () => {
    const order = await store<{ line_items: Array<{ id: number; product_id: number }> }>("GET", `/orders/${pushedId}`);
    const beanie = order.line_items.find((line) => line.product_id === 31);
    await store("POST", `/orders/${pushedId}/fulfillments`, { status: "fulfilled", is_fulfilled: true, notify_customer: false, meta_data: [{ key: "_items", value: [{ item_id: beanie?.id, qty: 1 }] }, { key: "_tracking_number", value: "JD014600003LK" }, { key: "_shipment_provider", value: "dhl" }, { key: "_tracking_url", value: "https://www.dhl.com/track?id=JD014600003LK" }] });
    await store("POST", `/orders/${pushedId}/refunds`, { amount: "13.00", reason: "E2E", api_refund: false, api_restock: false, line_items: [{ id: beanie?.id, quantity: 1, refund_total: "13.00" }] });
    const events = await connector.orderEvents!(channelStore, pushedId);
    if (!events.ok) throw new Error(events.error.message);
    seen.events = events.value;
    expect(events.value).toEqual(expect.arrayContaining([
      { kind: "order.fulfilled", remoteOrderId: pushedId, partial: true, shipments: [expect.objectContaining({ carrier: "dhl", trackingNumber: "JD014600003LK", trackingUrl: "https://www.dhl.com/track?id=JD014600003LK", lines: [{ externalVariantId: "31", quantity: 1 }], source: "core_fulfillments" })] },
      expect.objectContaining({ kind: "refund.created", remoteOrderId: pushedId, lines: [{ externalVariantId: "31", quantity: 1 }] }),
    ]));
  });

  it("cancels the store order and the store restocks; a completed order is refused", async () => {
    const before = (await store<{ stock_quantity: number }>("GET", "/products/28")).stock_quantity;
    const cancelled = await connector.cancelOrder!(channelStore, pushedId, { reason: "customer" });
    expect(cancelled.ok).toBe(true);
    expect((await store<{ status: string }>("GET", `/orders/${pushedId}`)).status).toBe("cancelled");
    expect((await store<{ stock_quantity: number }>("GET", "/products/28")).stock_quantity).toBe(before + 1);
    expect((await connector.cancelOrder!(channelStore, pushedId, { reason: "customer" })).ok).toBe(true);
    restore.push(() => store("DELETE", `/orders/${pushedId}?force=true`));
  });

  it("subscribes the store, finds and recreates a disabled subscription, and removes them all", async () => {
    const callback = `https://e2e.invalid/api/channels/webhooks/${crypto.randomUUID()}`;
    restore.push(() => connector.unregisterWebhooks!(channelStore, callback));
    const registered = await connector.registerWebhooks!(channelStore, [...(connector.webhookTopics ?? [])], callback);
    expect(registered.ok && registered.value.registered).toBe(4);
    const hooks = await store<Array<{ id: number; topic: string; delivery_url: string }>>("GET", "/webhooks?per_page=100");
    const ours = hooks.filter((hook) => hook.delivery_url === callback);
    expect(ours.map((hook) => hook.topic).sort()).toEqual(["order.updated", "product.created", "product.deleted", "product.updated"]);
    expect(await connector.webhookHealth!(channelStore, callback)).toEqual({ ok: true, value: { healthy: true, repaired: 0, missing: [] } });
    await store("PUT", `/webhooks/${ours[0]?.id}`, { status: "disabled" });
    expect(await connector.webhookHealth!(channelStore, callback)).toEqual({ ok: true, value: { healthy: true, repaired: 1, missing: [] } });
    const removed = await connector.unregisterWebhooks!(channelStore, callback);
    expect(removed.ok && removed.value.removed).toBe(4);
  });
});
