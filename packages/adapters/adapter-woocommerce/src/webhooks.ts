import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Err, Ok, toMinorUnits } from "@porulle/core";
import type { ChannelConnectorError, ChannelEvent, ChannelShipment, ChannelStore, ChannelWebhookEvent, ChannelWebhookHealth, Result } from "@porulle/core";
import { z } from "zod";
import { wooProductSchema, wooVariationSchema } from "./catalog.js";
import type { WooClient } from "./client.js";
import { available } from "./inventory.js";
import { ORDER_META_KEY, wooOrderSchema } from "./orders.js";
import type { WooOrder } from "./orders.js";

/** What every store is subscribed to: catalogue and stock changes, and every change to an order. */
export const WOO_WEBHOOK_TOPICS = ["product.created", "product.updated", "product.deleted", "order.updated"] as const;

const id = z.union([z.number(), z.string()]).transform(String);

function validSignature(secret: string, body: string, signature: string | null): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  const given = Buffer.from(signature, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * A delivery to the store's own address. The ping WooCommerce sends when a subscription is created
 * (form body `webhook_id=N`, unsigned) is `Ok(null)`. Everything else must carry a valid signature.
 *
 * The id is ours: `X-WC-Webhook-Delivery-ID` hashes the subscription id and the current SECOND, so two
 * deliveries in one second collide. So does `date_modified_gmt`, which is also to the second: two stock
 * changes inside one second differ only in the stock. The topic and the whole signed body identify a
 * delivery: a replay is the same bytes, and any other state is a change to apply.
 */
export async function verifyDelivery(store: ChannelStore, request: Request): Promise<Result<ChannelWebhookEvent | null, ChannelConnectorError>> {
  const body = await request.text();
  if (/^webhook_id=\d+$/.test(body.trim()) && !request.headers.get("x-wc-webhook-signature")) return Ok(null);
  if (!validSignature(store.webhookSecret ?? "", body, request.headers.get("x-wc-webhook-signature"))) {
    return Err({ code: "INVALID_WEBHOOK_SIGNATURE", message: "Invalid WooCommerce webhook signature.", retriable: false });
  }
  const topic = request.headers.get("x-wc-webhook-topic");
  if (!topic) return Err({ code: "INVALID_WEBHOOK", message: "A WooCommerce delivery named no topic.", retriable: false });
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return Err({ code: "INVALID_WEBHOOK", message: "A WooCommerce delivery body was not JSON.", retriable: false });
  }
  return Ok({ id: createHash("sha256").update(`${topic}|${body}`).digest("hex"), type: topic, data });
}

const variationNudge = z.object({ id, type: z.string().optional(), parent_id: id.nullish() });

/** A product delivery is a nudge: the product (and its stock) is read fresh. */
async function decodeProduct(client: WooClient, topic: string, data: unknown, untracked: number): Promise<Result<ChannelEvent[], ChannelConnectorError>> {
  const nudge = variationNudge.safeParse(data);
  if (!nudge.success) return Ok([]);
  const isVariation = nudge.data.type === "variation" && nudge.data.parent_id && nudge.data.parent_id !== "0";
  if (topic === "product.deleted") {
    return Ok(isVariation ? [{ kind: "product.changed", externalIds: [nudge.data.parent_id ?? ""] }] : [{ kind: "product.deleted", externalIds: [nudge.data.id] }]);
  }
  if (isVariation) {
    const variation = await client.get(`/wc/v3/products/${encodeURIComponent(nudge.data.id)}`, wooVariationSchema);
    if (!variation.ok) return variation;
    return Ok([
      { kind: "product.changed", externalIds: [nudge.data.parent_id ?? ""] },
      { kind: "inventory.changed", levels: [{ externalId: variation.value.data.id, available: available(variation.value.data, untracked) }] },
    ]);
  }
  const product = await client.get(`/wc/v3/products/${encodeURIComponent(nudge.data.id)}`, wooProductSchema);
  if (!product.ok) return product;
  const events: ChannelEvent[] = [{ kind: "product.changed", externalIds: [product.value.data.id] }];
  if (product.value.data.type === "simple") {
    events.push({ kind: "inventory.changed", levels: [{ externalId: product.value.data.id, available: available(product.value.data, untracked) }] });
  } else if (product.value.data.type === "variable" && product.value.data.variations.length > 0) {
    const variations = await client.all(`/wc/v3/products/${encodeURIComponent(product.value.data.id)}/variations`, wooVariationSchema);
    if (!variations.ok) return variations;
    events.push({ kind: "inventory.changed", levels: variations.value.map((row) => ({ externalId: row.id, available: available(row, untracked) })) });
  }
  return Ok(events);
}

const fulfillmentSchema = z.object({
  id,
  // A boolean when created, the string "1" or "0" when listed (measured on WooCommerce 11.1.2).
  is_fulfilled: z.union([z.boolean(), z.string(), z.number()]).nullish().transform((value) => value === true || value === "1" || value === 1),
  meta_data: z.array(z.object({ key: z.string(), value: z.unknown() })).default([]),
});
const fulfillmentItems = z.array(z.object({ item_id: id, qty: z.coerce.number().int() }));
const trackingItem = z.object({
  tracking_id: z.string().nullish(),
  tracking_provider: z.string().nullish(),
  custom_tracking_provider: z.string().nullish(),
  tracking_number: z.string().nullish(),
  tracking_link: z.string().nullish(),
  custom_tracking_link: z.string().nullish(),
});
const refundSchema = z.object({
  id,
  /** What the merchant refunded, positive, in the store's currency: part of a line is less than the line. */
  amount: z.string().nullish(),
  line_items: z.array(z.object({ product_id: id, variation_id: id, quantity: z.number() })).default([]),
});

function meta(entries: Array<{ key: string; value: unknown }>, key: string): unknown {
  return entries.find((entry) => entry.key === key)?.value;
}

/** The variant id an order line names: its variation's, else its product's. */
function lineVariant(line: WooOrder["line_items"][number]): string {
  return line.variation_id !== "0" ? line.variation_id : line.product_id;
}

/**
 * Where the store keeps tracking, tried in order: WooCommerce's own fulfilments (11.x, when enabled),
 * the Shipment Tracking / Advanced Shipment Tracking route, the same plugins' order meta, and finally
 * none at all (a completed order with no tracking still shipped).
 */
async function shipments(client: WooClient, order: WooOrder): Promise<Result<ChannelShipment[], ChannelConnectorError>> {
  const native = await client.get(`/wc/v3/orders/${encodeURIComponent(order.id)}/fulfillments`, z.array(fulfillmentSchema));
  // A store without native fulfilments answers 404 (no such route); any other failure is real.
  if (!native.ok && native.error.status !== 404) return native;
  if (native.ok && native.value.data.length > 0) {
    const byItem = new Map(order.line_items.map((line) => [line.id, lineVariant(line)]));
    return Ok(native.value.data.filter((parcel) => parcel.is_fulfilled).map((parcel) => {
      const items = fulfillmentItems.safeParse(meta(parcel.meta_data, "_items"));
      const number = z.string().safeParse(meta(parcel.meta_data, "_tracking_number"));
      const provider = z.string().safeParse(meta(parcel.meta_data, "_shipment_provider"));
      const url = z.string().safeParse(meta(parcel.meta_data, "_tracking_url"));
      return {
        remoteId: `fulfillment-${parcel.id}`,
        ...(provider.success && provider.data ? { carrier: provider.data } : {}),
        ...(number.success && number.data ? { trackingNumber: number.data } : {}),
        ...(url.success && url.data ? { trackingUrl: url.data } : {}),
        lines: items.success ? items.data.flatMap((item) => {
          const variant = byItem.get(item.item_id);
          return variant ? [{ externalVariantId: variant, quantity: item.qty }] : [];
        }) : [],
        source: "core_fulfillments",
      };
    }));
  }
  const tracked = await client.get(`/wc-shipment-tracking/v3/orders/${encodeURIComponent(order.id)}/shipment-trackings`, z.array(trackingItem));
  const fromItems = (items: Array<z.infer<typeof trackingItem>>, source: string): ChannelShipment[] => items.flatMap((item, index) => {
    if (!item.tracking_number) return [];
    const carrier = item.custom_tracking_provider || item.tracking_provider;
    const link = item.custom_tracking_link || item.tracking_link;
    return [{ remoteId: `tracking-${item.tracking_id ?? index}`, ...(carrier ? { carrier } : {}), trackingNumber: item.tracking_number, ...(link ? { trackingUrl: link } : {}), lines: [], source }];
  });
  if (tracked.ok && tracked.value.data.length > 0) return Ok(fromItems(tracked.value.data, "shipment_tracking"));
  const metaItems = z.array(trackingItem).safeParse(meta(order.meta_data, "_wc_shipment_tracking_items"));
  if (metaItems.success && metaItems.data.length > 0) return Ok(fromItems(metaItems.data, "meta"));
  const plainNumber = z.string().min(1).safeParse(meta(order.meta_data, "_tracking_number"));
  if (plainNumber.success) return Ok([{ remoteId: `tracking-${plainNumber.data}`, trackingNumber: plainNumber.data, lines: [], source: "meta" }]);
  return Ok([{ remoteId: `completed-${order.id}`, lines: [], source: "status_only" }]);
}

/**
 * What an order now looks like, as events: cancelled, shipped (wholly or partly), refunded. Read
 * fresh — the delivery only says the order changed. An order the store did not receive from us is
 * none of ours.
 */
export async function orderEvents(client: WooClient, remoteOrderId: string): Promise<Result<ChannelEvent[], ChannelConnectorError>> {
  const read = await client.get(`/wc/v3/orders/${encodeURIComponent(remoteOrderId)}`, wooOrderSchema);
  if (!read.ok) return read;
  const order = read.value.data;
  if (!order.meta_data.some((entry) => entry.key === ORDER_META_KEY)) return Ok([]);
  const events: ChannelEvent[] = [];
  if (order.status === "cancelled") events.push({ kind: "order.cancelled", remoteOrderId: order.id });
  const fulfilment = meta(order.meta_data, "_fulfillment_status");
  if (order.status === "completed" || fulfilment === "fulfilled" || fulfilment === "partially_fulfilled") {
    const parcels = await shipments(client, order);
    if (!parcels.ok) return parcels;
    events.push({ kind: "order.fulfilled", remoteOrderId: order.id, partial: order.status !== "completed" && fulfilment === "partially_fulfilled", shipments: parcels.value });
  }
  for (const summary of order.refunds) {
    const refund = await client.get(`/wc/v3/orders/${encodeURIComponent(order.id)}/refunds/${encodeURIComponent(summary.id)}`, refundSchema);
    if (!refund.ok) return refund;
    const currency = order.currency ?? client.credentials.currency;
    const amount = currency ? toMinorUnits(refund.value.data.amount, currency) : undefined;
    events.push({
      kind: "refund.created",
      remoteOrderId: order.id,
      remoteRefundId: refund.value.data.id,
      lines: refund.value.data.line_items.flatMap((line) => {
        const quantity = Math.abs(line.quantity);
        return quantity > 0 ? [{ externalVariantId: line.variation_id !== "0" ? line.variation_id : line.product_id, quantity }] : [];
      }),
      ...(amount === undefined ? {} : { amount: Math.abs(amount) }),
    });
  }
  return Ok(events);
}

export async function decodeDelivery(client: WooClient, event: ChannelWebhookEvent, untracked: number): Promise<Result<ChannelEvent[], ChannelConnectorError>> {
  if (event.type.startsWith("product.")) return decodeProduct(client, event.type, event.data, untracked);
  if (event.type === "order.updated" || event.type === "order.created") {
    const order = z.object({ id }).safeParse(event.data);
    return order.success ? orderEvents(client, order.data.id) : Ok([]);
  }
  return Ok([]);
}

const webhookSchema = z.object({ id, topic: z.string(), status: z.string(), delivery_url: z.string() });

export async function registerWebhooks(client: WooClient, store: ChannelStore, topics: readonly string[], callbackUrl: string): Promise<Result<{ registered: number }, ChannelConnectorError>> {
  if (!store.webhookSecret) return Err({ code: "WOO_WEBHOOK_SECRET_MISSING", message: "The store has no webhook secret to sign with.", retriable: false });
  const existing = await client.all("/wc/v3/webhooks", webhookSchema);
  if (!existing.ok) return existing;
  let registered = 0;
  for (const topic of topics) {
    // A reconnect keeps a subscription that is already there and active.
    if (existing.value.some((hook) => hook.delivery_url === callbackUrl && hook.topic === topic && hook.status === "active")) continue;
    const created = await client.send("POST", "/wc/v3/webhooks", { name: `Runvae ${topic}`, topic, delivery_url: callbackUrl, secret: store.webhookSecret, status: "active" }, webhookSchema);
    if (!created.ok) return created;
    registered += 1;
  }
  return Ok({ registered });
}

export async function unregisterWebhooks(client: WooClient, callbackUrl: string): Promise<Result<{ removed: number }, ChannelConnectorError>> {
  const existing = await client.all("/wc/v3/webhooks", webhookSchema);
  if (!existing.ok) return existing;
  let removed = 0;
  for (const hook of existing.value.filter((candidate) => candidate.delivery_url === callbackUrl)) {
    const deleted = await client.send("DELETE", `/wc/v3/webhooks/${encodeURIComponent(hook.id)}`, undefined, z.unknown(), { force: "true" });
    if (!deleted.ok) return deleted;
    removed += 1;
  }
  return Ok({ removed });
}

/**
 * WooCommerce disables a subscription after repeated failed deliveries and never says so. Each expected
 * topic missing, paused or disabled is deleted and created again: re-activating keeps the failure count,
 * so the next failure would disable it again at once.
 */
export async function webhookHealth(client: WooClient, store: ChannelStore, topics: readonly string[], callbackUrl: string): Promise<Result<ChannelWebhookHealth, ChannelConnectorError>> {
  const existing = await client.all("/wc/v3/webhooks", webhookSchema);
  if (!existing.ok) return existing;
  const ours = existing.value.filter((hook) => hook.delivery_url === callbackUrl);
  let repaired = 0;
  const missing: string[] = [];
  for (const topic of topics) {
    const matching = ours.filter((hook) => hook.topic === topic);
    if (matching.some((hook) => hook.status === "active")) continue;
    for (const hook of matching) {
      const deleted = await client.send("DELETE", `/wc/v3/webhooks/${encodeURIComponent(hook.id)}`, undefined, z.unknown(), { force: "true" });
      if (!deleted.ok) return deleted;
    }
    const created = await registerWebhooks(client, store, [topic], callbackUrl);
    if (created.ok) repaired += 1;
    else missing.push(topic);
  }
  return Ok({ healthy: missing.length === 0, repaired, missing });
}
