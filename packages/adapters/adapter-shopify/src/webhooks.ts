import { Err, Ok, toMinorUnits } from "@porulle/core";
import type { ChannelConnectorError, ChannelEvent, ChannelShipment, ChannelWebhookEvent, Result } from "@porulle/core";
import { z } from "zod";
import { shopifyGid, shopifyGraphql } from "./graphql.js";
import type { ShopifyGraphqlTarget } from "./graphql.js";

/**
 * A stock delivery names an INVENTORY ITEM and one location's count. The variant it belongs to and
 * its stock summed over locations are read fresh, so the level applied is the store's, not the payload's.
 */
export const INVENTORY_ITEM_VARIANT_QUERY = `query PorulleInventoryItemVariant($id: ID!) {
  inventoryItem(id: $id) { variant { legacyResourceId inventoryQuantity } }
}`;

const inventoryItemVariantSchema = z.object({
  inventoryItem: z.object({ variant: z.object({ legacyResourceId: z.string(), inventoryQuantity: z.number().nullable() }).nullable() }).nullable(),
});

const id = z.union([z.string(), z.number()]).transform(String);
const withId = z.object({ id });
const inventoryLevelPayload = z.object({ inventory_item_id: id });
const decimal = z.union([z.string(), z.number()]).transform(String);
const refundPayload = z.object({
  id,
  order_id: id,
  refund_line_items: z.array(z.object({
    quantity: z.number().int(),
    line_item: z.object({ variant_id: id.nullish(), product_id: id.nullish() }),
  })).default([]),
  /** The money the refund moved. Absent from payloads that predate it; an empty list refunded nothing. */
  transactions: z.array(z.object({ kind: z.string(), status: z.string().nullish(), amount: decimal, currency: z.string().nullish() })).optional(),
  refund_shipping_lines: z.array(z.object({
    subtotal_amount_set: z.object({ shop_money: z.object({ amount: decimal, currency_code: z.string() }) }),
  })).default([]),
});

/**
 * What a Shopify refund paid back: its successful refund transactions (an order paid on the
 * marketplace refunds through the `manual` gateway), and of that the delivery, from
 * `refund_shipping_lines` (present on every payload of the pinned API version).
 */
function refundMoney(refund: z.infer<typeof refundPayload>): { amount?: number; shippingAmount?: number } {
  const currency = refund.transactions?.find((transaction) => transaction.currency)?.currency
    ?? refund.refund_shipping_lines[0]?.subtotal_amount_set.shop_money.currency_code;
  // Money with no currency cannot be read in minor units; counted as nothing, it can only under-ask.
  const minor = (value: string): number => (currency ? Math.abs(toMinorUnits(value, currency) ?? 0) : 0);
  const amount = refund.transactions === undefined
    ? undefined
    : refund.transactions.filter((transaction) => transaction.kind.toLowerCase() === "refund" && (transaction.status ?? "success").toLowerCase() === "success").reduce((sum, transaction) => sum + minor(transaction.amount), 0);
  const shippingAmount = refund.refund_shipping_lines.reduce((sum, line) => sum + minor(line.subtotal_amount_set.shop_money.amount), 0);
  return { ...(amount === undefined ? {} : { amount }), ...(shippingAmount > 0 ? { shippingAmount } : {}) };
}
const fulfilledPayload = z.object({
  id,
  fulfillments: z.array(z.object({
    id,
    status: z.string().nullish(),
    tracking_company: z.string().nullish(),
    tracking_number: z.string().nullish(),
    tracking_url: z.string().nullish(),
    line_items: z.array(z.object({ variant_id: id.nullish(), quantity: z.number().int().positive() })).default([]),
  })).default([]),
});

const RETURN_STATUS: Record<string, Extract<ChannelEvent, { kind: "return.updated" }>["status"]> = {
  "returns/approve": "approved",
  "returns/decline": "declined",
  "returns/close": "closed",
  "returns/cancel": "cancelled",
  "returns/reopen": "approved",
};

const COMPLIANCE: Record<string, Extract<ChannelEvent, { kind: "compliance.request" }>["request"]> = {
  "customers/data_request": "customer_data",
  "customers/redact": "customer_redact",
  "shop/redact": "shop_redact",
};

function malformed(topic: string, error: z.ZodError): Result<never, ChannelConnectorError> {
  return Err({ code: "SHOPIFY_WEBHOOK_MALFORMED", message: `A Shopify ${topic} delivery did not parse: ${error.message}`, retriable: false });
}

/** A parcel the store cancelled or failed is not a parcel. */
function shipments(fulfillments: z.infer<typeof fulfilledPayload>["fulfillments"]): ChannelShipment[] {
  return fulfillments
    .filter((parcel) => parcel.status !== "cancelled" && parcel.status !== "error" && parcel.status !== "failure")
    .map((parcel) => ({
      remoteId: parcel.id,
      ...(parcel.tracking_company ? { carrier: parcel.tracking_company } : {}),
      ...(parcel.tracking_number ? { trackingNumber: parcel.tracking_number } : {}),
      ...(parcel.tracking_url ? { trackingUrl: parcel.tracking_url } : {}),
      lines: parcel.line_items.flatMap((line) => (line.variant_id == null ? [] : [{ externalVariantId: line.variant_id, quantity: line.quantity }])),
    }));
}

/** What one Shopify delivery means. `shop` is the store's Admin API, for the reads a nudge needs. */
export async function decodeShopifyWebhook(shop: ShopifyGraphqlTarget | undefined, event: ChannelWebhookEvent): Promise<Result<ChannelEvent[], ChannelConnectorError>> {
  const topic = event.type;
  const data = event.data;
  if (topic === "products/create" || topic === "products/update" || topic === "products/delete") {
    const parsed = withId.safeParse(data);
    if (!parsed.success) return malformed(topic, parsed.error);
    return Ok([{ kind: topic === "products/delete" ? "product.deleted" : "product.changed", externalIds: [parsed.data.id] }]);
  }
  if (topic === "inventory_levels/update") {
    const parsed = inventoryLevelPayload.safeParse(data);
    if (!parsed.success) return malformed(topic, parsed.error);
    if (!shop) return Err({ code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "The store holds no Shopify access token; it must be reconnected.", retriable: false });
    const read = await shopifyGraphql(shop, INVENTORY_ITEM_VARIANT_QUERY, { id: shopifyGid("InventoryItem", parsed.data.inventory_item_id) }, inventoryItemVariantSchema);
    if (!read.ok) return read;
    const variant = read.value.inventoryItem?.variant;
    // An item no variant carries (deleted between the delivery and the read) has no level to apply.
    if (!variant) return Ok([]);
    return Ok([{ kind: "inventory.changed", levels: [{ externalId: variant.legacyResourceId, available: Math.max(0, variant.inventoryQuantity ?? 0) }] }]);
  }
  if (topic === "orders/cancelled") {
    const parsed = withId.safeParse(data);
    if (!parsed.success) return malformed(topic, parsed.error);
    return Ok([{ kind: "order.cancelled", remoteOrderId: parsed.data.id }]);
  }
  if (topic === "orders/fulfilled" || topic === "orders/partially_fulfilled") {
    const parsed = fulfilledPayload.safeParse(data);
    if (!parsed.success) return malformed(topic, parsed.error);
    return Ok([{ kind: "order.fulfilled", remoteOrderId: parsed.data.id, partial: topic === "orders/partially_fulfilled", shipments: shipments(parsed.data.fulfillments) }]);
  }
  if (topic === "refunds/create") {
    const parsed = refundPayload.safeParse(data);
    if (!parsed.success) return malformed(topic, parsed.error);
    return Ok([{
      kind: "refund.created",
      remoteOrderId: parsed.data.order_id,
      remoteRefundId: parsed.data.id,
      lines: parsed.data.refund_line_items.flatMap((entry) => {
        const externalVariantId = entry.line_item.variant_id ?? entry.line_item.product_id;
        return externalVariantId == null ? [] : [{ externalVariantId, quantity: entry.quantity }];
      }),
      ...refundMoney(parsed.data),
    }]);
  }
  const returnStatus = RETURN_STATUS[topic];
  if (returnStatus !== undefined) {
    const parsed = withId.safeParse(data);
    if (!parsed.success) return malformed(topic, parsed.error);
    return Ok([{ kind: "return.updated", remoteReturnId: parsed.data.id, status: returnStatus }]);
  }
  if (topic === "app/uninstalled") return Ok([{ kind: "connection.revoked" }]);
  const compliance = COMPLIANCE[topic];
  if (compliance !== undefined) {
    const parsed = z.record(z.string(), z.unknown()).safeParse(data);
    if (!parsed.success) return malformed(topic, parsed.error);
    return Ok([{ kind: "compliance.request", request: compliance, data: parsed.data }]);
  }
  return Ok([]);
}
