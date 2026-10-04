import { CHANNEL_CANCEL_REFUSED, CHANNEL_OUT_OF_STOCK, CHANNEL_TOTAL_MISMATCH, currencyExponent, Err, Ok, toMinorUnits } from "@porulle/core";
import type { ChannelCancelOrderInput, ChannelConnectorError, ChannelOrderSlice, ChannelOrderStatus, ChannelPushOrderResult, Result } from "@porulle/core";
import { z } from "zod";
import type { WooClient } from "./client.js";
import { available } from "./inventory.js";

const id = z.union([z.number(), z.string()]).transform(String);

export const wooOrderSchema = z.object({
  id,
  status: z.string(),
  total: z.string(),
  currency: z.string().nullish(),
  date_created_gmt: z.string().nullish(),
  meta_data: z.array(z.object({ key: z.string(), value: z.unknown() })).default([]),
  line_items: z.array(z.object({ id, product_id: id, variation_id: id, quantity: z.number(), total: z.string().nullish() })).default([]),
  refunds: z.array(z.object({ id, total: z.string().nullish() })).default([]),
});
export type WooOrder = z.infer<typeof wooOrderSchema>;

/** The meta key naming the marketplace order a store order was created for: how a retry finds it. */
export const ORDER_META_KEY = "_porulle_order_id";

const lineTargetSchema = z.object({
  id,
  type: z.string(),
  parent_id: id.nullish(),
  manage_stock: z.union([z.boolean(), z.literal("parent")]).nullish(),
  stock_quantity: z.number().nullish(),
  stock_status: z.string().nullish(),
});

/** Minor units as WooCommerce's money string: a string always (a number is refused), at the store's decimals. */
export function moneyString(minor: number, currency: string, decimals: number | undefined): string {
  const exponent = currencyExponent(currency);
  return (minor / 10 ** exponent).toFixed(decimals ?? exponent);
}

function ours(order: WooOrder, orderId: string): boolean {
  return order.meta_data.some((meta) => meta.key === ORDER_META_KEY && meta.value === orderId);
}

/** Never mistaken for a store order a merchant made: only a match on our own meta key counts. */
async function findExisting(client: WooClient, orderId: string): Promise<Result<WooOrder | undefined, ChannelConnectorError>> {
  const searched = await client.get("/wc/v3/orders", z.array(wooOrderSchema), { search: orderId, per_page: "20", status: "any" });
  if (!searched.ok) return searched;
  const found = searched.value.data.find((order) => ours(order, orderId));
  if (found) return Ok(found);
  // Some stores (HPOS) do not search the note. The recent orders are scanned too: a lost answer is
  // retried within minutes, so the order it created is recent.
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const recent = await client.get("/wc/v3/orders", z.array(wooOrderSchema), { after: since, dates_are_gmt: "true", per_page: "100", orderby: "date", order: "desc", status: "any" });
  if (!recent.ok) return recent;
  return Ok(recent.value.data.find((order) => ours(order, orderId)));
}

function remoteUrl(client: WooClient, orderId: string): string {
  return client.credentials.hpos
    ? `${client.base}/wp-admin/admin.php?page=wc-orders&action=edit&id=${orderId}`
    : `${client.base}/wp-admin/post.php?post=${orderId}&action=edit`;
}

/** The discount spread over the lines in proportion to their totals, the rounding remainder on the last. */
function allocate(totals: number[], discount: number): number[] {
  const sum = totals.reduce((acc, value) => acc + value, 0);
  if (discount <= 0 || sum <= 0) return totals.map(() => 0);
  const shares = totals.map((value) => Math.floor((value * discount) / sum));
  shares[shares.length - 1] = (shares.at(-1) ?? 0) + discount - shares.reduce((acc, value) => acc + value, 0);
  return shares;
}

export interface PushOrderOptions {
  paymentMethodTitle: string;
  untrackedStockQuantity: number;
}

/**
 * Creates the paid order in the store, at exactly what the shopper paid, once.
 *
 * WooCommerce never refuses an order for stock (it goes negative), has no idempotency key, and adds
 * its own tax to whatever it is sent. So: stock is read fresh first; every line carries the
 * `zero-rate` tax class and the delivery its own line; the total is checked after; a store order
 * that oversold or came out at another total is cancelled again (cancelling restocks). The create is
 * never retried here: an unclear answer is a retriable failure, and the next attempt finds the order
 * by our meta key before creating anything.
 */
export async function pushOrder(client: WooClient, slice: ChannelOrderSlice, options: PushOrderOptions): Promise<Result<ChannelPushOrderResult, ChannelConnectorError>> {
  const existing = await findExisting(client, slice.orderId);
  if (!existing.ok) return existing;
  if (existing.value) return Ok({ remoteOrderId: existing.value.id, remoteUrl: remoteUrl(client, existing.value.id) });

  // Each line's product, read fresh: whether it is a variation, and how many the store can sell.
  const targets = new Map<string, z.infer<typeof lineTargetSchema>>();
  for (const line of slice.lines) {
    const read = await client.get(`/wc/v3/products/${encodeURIComponent(line.externalVariantId)}`, lineTargetSchema);
    if (!read.ok) {
      if (read.error.status === 404) {
        return Err({ code: CHANNEL_OUT_OF_STOCK, message: `The store no longer sells item ${line.externalVariantId}.`, retriable: false });
      }
      return read;
    }
    targets.set(line.externalVariantId, read.value.data);
  }
  const short = slice.lines.filter((line) => {
    const target = targets.get(line.externalVariantId);
    return !target || available(target, options.untrackedStockQuantity) < line.quantity;
  });
  if (short.length > 0) {
    return Err({ code: CHANNEL_OUT_OF_STOCK, message: `The store does not have the stock for ${short.map((line) => `${line.quantity} × ${line.title}`).join(", ")}.`, retriable: false });
  }

  const currency = slice.currency;
  const decimals = client.credentials.priceDecimals;
  const discounts = allocate(slice.lines.map((line) => line.totalPrice), slice.discount?.amount ?? 0);
  const [firstName = "", ...rest] = slice.customer.name.trim().split(/\s+/);
  const source = slice.customer.shippingAddress;
  const address = {
    first_name: source.firstName,
    last_name: source.lastName,
    address_1: source.line1,
    address_2: source.line2 ?? "",
    city: source.city,
    state: source.region ?? "",
    postcode: source.postalCode ?? "",
    country: source.countryCode,
    phone: source.phone ?? "",
  };
  const body = {
    set_paid: true,
    currency,
    payment_method: "runvae",
    payment_method_title: options.paymentMethodTitle,
    transaction_id: slice.orderId,
    customer_note: `Runvae order ${slice.orderId}`,
    meta_data: [{ key: ORDER_META_KEY, value: slice.orderId }],
    billing: { ...address, first_name: firstName || source.firstName, last_name: rest.join(" ") || source.lastName, email: slice.customer.email },
    shipping: address,
    line_items: slice.lines.map((line, index) => {
      const target = targets.get(line.externalVariantId);
      const isVariation = target?.type === "variation";
      return {
        ...(isVariation ? { variation_id: Number(line.externalVariantId) } : { product_id: Number(line.externalVariantId) }),
        quantity: line.quantity,
        subtotal: moneyString(line.totalPrice, currency, decimals),
        total: moneyString(line.totalPrice - (discounts[index] ?? 0), currency, decimals),
        tax_class: "zero-rate",
      };
    }),
    shipping_lines: slice.shipping ? [{ method_id: "flat_rate", method_title: slice.shipping.title, total: moneyString(slice.shipping.amount, currency, decimals) }] : [],
  };

  const created = await client.send("POST", "/wc/v3/orders", body, wooOrderSchema);
  if (!created.ok) {
    const error = created.error;
    const draft = error.body?.data;
    const draftId = draft && typeof draft === "object" && "new_draft_order_id" in draft ? z.coerce.number().int().positive().safeParse(draft.new_draft_order_id) : undefined;
    // A refusal can leave a checkout-draft behind; it is ours, so it goes.
    if (draftId?.success) await client.send("DELETE", `/wc/v3/orders/${draftId.data}`, undefined, z.unknown(), { force: "true" });
    // A 4xx is the store's answer. Anything else (timeout, 5xx, unreadable) may have created the
    // order: retriable, and the next attempt looks for it before creating.
    const answered = error.status !== undefined && error.status >= 400 && error.status < 500;
    return Err({ code: answered ? "WOO_ORDER_REJECTED" : error.code, message: answered ? `WooCommerce refused the order: ${error.message}` : `The store's answer to the order was lost (${error.message}); it is looked for before trying again.`, retriable: !answered });
  }
  const order = created.value;

  const total = toMinorUnits(order.total, currency);
  if (total !== slice.grandTotal) {
    await cancel(client, order.id, `Runvae: total ${order.total} is not what the shopper paid.`);
    return Err({ code: CHANNEL_TOTAL_MISMATCH, message: `The store priced the order at ${order.total} ${currency}, not the ${moneyString(slice.grandTotal, currency, decimals)} the shopper paid (is the "Zero rate" tax class still there?). The store order was cancelled.`, retriable: false });
  }
  // Two orders racing for the last unit both pass the read above; the store then sits below zero.
  for (const line of slice.lines) {
    const after = await client.get(`/wc/v3/products/${encodeURIComponent(line.externalVariantId)}`, lineTargetSchema);
    if (after.ok && (after.value.data.manage_stock === true || after.value.data.manage_stock === "parent") && (after.value.data.stock_quantity ?? 0) < 0) {
      await cancel(client, order.id, "Runvae: the store did not have the stock.");
      return Err({ code: CHANNEL_OUT_OF_STOCK, message: `The store sold out of ${line.title} while the order was placed. The store order was cancelled and restocked.`, retriable: false });
    }
  }
  return Ok({ remoteOrderId: order.id, remoteUrl: remoteUrl(client, order.id) });
}

async function cancel(client: WooClient, orderId: string, note: string): Promise<Result<WooOrder, ChannelConnectorError>> {
  await client.send("POST", `/wc/v3/orders/${encodeURIComponent(orderId)}/notes`, { note, customer_note: false }, z.unknown());
  return client.send("PUT", `/wc/v3/orders/${encodeURIComponent(orderId)}`, { status: "cancelled" }, wooOrderSchema);
}

/**
 * Cancels an order we pushed. WooCommerce restocks on cancel. An order already cancelled is success; a
 * completed or refunded one is the merchant's (shipped) and is refused, never moved backwards.
 */
export async function cancelOrder(client: WooClient, remoteId: string, input: ChannelCancelOrderInput): Promise<Result<void, ChannelConnectorError>> {
  const read = await client.get(`/wc/v3/orders/${encodeURIComponent(remoteId)}`, wooOrderSchema);
  if (!read.ok) return read;
  if (read.value.data.status === "cancelled") return Ok(undefined);
  if (read.value.data.status === "completed" || read.value.data.status === "refunded") {
    return Err({ code: CHANNEL_CANCEL_REFUSED, message: `The store has already ${read.value.data.status === "completed" ? "completed (shipped)" : "refunded"} order ${remoteId}.`, retriable: false });
  }
  const cancelled = await cancel(client, remoteId, `Runvae: cancelled (${input.reason})${input.staffNote ? `: ${input.staffNote}` : ""}.`);
  return cancelled.ok ? Ok(undefined) : cancelled;
}

export async function orderStatus(client: WooClient, remoteId: string): Promise<Result<ChannelOrderStatus, ChannelConnectorError>> {
  const read = await client.get(`/wc/v3/orders/${encodeURIComponent(remoteId)}`, wooOrderSchema);
  if (!read.ok) return read;
  const status = read.value.data.status;
  if (status === "completed") return Ok({ status: "fulfilled" });
  if (status === "processing" || status === "on-hold") return Ok({ status: "confirmed" });
  if (status === "cancelled") return Ok({ status: "cancelled" });
  if (status === "failed" || status === "refunded") return Ok({ status: "failed" });
  return Ok({ status: "pending" });
}
