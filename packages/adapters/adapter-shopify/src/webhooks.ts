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

/** The topics whose payload names the shop that sent it, signed: `shop_domain`. */
export function isComplianceTopic(topic: string): boolean {
  return topic in COMPLIANCE;
}

/** The topics `decodeShopifyWebhook` answers with a read of the shop's Admin API; every other decodes from its body. */
const READS_THE_STORE: ReadonlySet<string> = new Set(["inventory_levels/update"]);

export function decodeReadsTheStore(topic: string): boolean {
  return READS_THE_STORE.has(topic);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps an identifier/scalar field if present; replaces non-scalar malformed values with `false` so validation still rejects them without retaining PII. */
function keepId(value: unknown): string | number | boolean | null | undefined {
  if (value === undefined || value === null) return value;
  return typeof value === "string" || typeof value === "number" ? value : false;
}

function keepIdList(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return false;
  return value.map((entry) => (typeof entry === "string" || typeof entry === "number" ? entry : false));
}

function keepString(value: unknown): string | boolean | null | undefined {
  if (value === undefined || value === null) return value;
  return typeof value === "string" ? value : false;
}

/**
 * Keeps only the fields `decodeShopifyWebhook` and compliance handlers read before a delivery is
 * persisted in `commerce_jobs.input` — stripping shopper names, shipping/billing addresses, phone
 * numbers and any other extra webhook fields while preserving malformed-shape failures.
 */
export function minimizeShopifyWebhookPayload(topic: string, data: unknown): unknown {
  if (topic === "app/uninstalled") return {};
  if (!isPlainRecord(data)) return null;

  if (topic === "shop/redact") {
    const out: Record<string, unknown> = {};
    if ("shop_id" in data) out.shop_id = keepId(data.shop_id);
    if ("shop_domain" in data) out.shop_domain = keepString(data.shop_domain);
    return out;
  }

  if (topic === "customers/redact" || topic === "customers/data_request") {
    const out: Record<string, unknown> = {};
    if ("shop_id" in data) out.shop_id = keepId(data.shop_id);
    if ("shop_domain" in data) out.shop_domain = keepString(data.shop_domain);
    if ("email" in data) out.email = keepString(data.email);
    if ("customer_id" in data) out.customer_id = keepId(data.customer_id);
    if ("customer" in data) {
      if (data.customer === null) out.customer = null;
      else if (isPlainRecord(data.customer)) {
        const customer: Record<string, unknown> = {};
        if ("id" in data.customer) customer.id = keepId(data.customer.id);
        if ("email" in data.customer) customer.email = keepString(data.customer.email);
        out.customer = customer;
      } else {
        out.customer = false;
      }
    }
    if ("orders_to_redact" in data) out.orders_to_redact = keepIdList(data.orders_to_redact);
    if ("orders_requested" in data) out.orders_requested = keepIdList(data.orders_requested);
    if ("data_request" in data) {
      if (data.data_request === null) out.data_request = null;
      else if (isPlainRecord(data.data_request)) {
        out.data_request = "id" in data.data_request ? { id: keepId(data.data_request.id) } : {};
      } else {
        out.data_request = false;
      }
    }
    return out;
  }

  if (topic === "orders/cancelled") {
    return "id" in data ? { id: keepId(data.id) } : {};
  }

  if (topic === "orders/fulfilled" || topic === "orders/partially_fulfilled") {
    const out: Record<string, unknown> = {};
    if ("id" in data) out.id = keepId(data.id);
    if ("fulfillments" in data) {
      if (!Array.isArray(data.fulfillments)) {
        out.fulfillments = false;
      } else {
        out.fulfillments = data.fulfillments.map((parcel) => {
          if (!isPlainRecord(parcel)) return false;
          const minimal: Record<string, unknown> = {};
          if ("id" in parcel) minimal.id = keepId(parcel.id);
          if ("status" in parcel) minimal.status = keepString(parcel.status);
          if ("tracking_company" in parcel) minimal.tracking_company = keepString(parcel.tracking_company);
          if ("tracking_number" in parcel) minimal.tracking_number = keepString(parcel.tracking_number);
          if ("tracking_url" in parcel) minimal.tracking_url = keepString(parcel.tracking_url);
          if ("line_items" in parcel) {
            minimal.line_items = Array.isArray(parcel.line_items)
              ? parcel.line_items.map((line) => (isPlainRecord(line)
                ? {
                  ...("variant_id" in line ? { variant_id: keepId(line.variant_id) } : {}),
                  ...("quantity" in line ? { quantity: typeof line.quantity === "number" ? line.quantity : false } : {}),
                }
                : false))
              : false;
          }
          return minimal;
        });
      }
    }
    return out;
  }

  if (topic === "refunds/create") {
    const out: Record<string, unknown> = {};
    if ("id" in data) out.id = keepId(data.id);
    if ("order_id" in data) out.order_id = keepId(data.order_id);
    if ("refund_line_items" in data) {
      out.refund_line_items = Array.isArray(data.refund_line_items)
        ? data.refund_line_items.map((entry) => {
          if (!isPlainRecord(entry)) return false;
          const minimal: Record<string, unknown> = {};
          if ("quantity" in entry) minimal.quantity = typeof entry.quantity === "number" ? entry.quantity : false;
          if ("line_item" in entry) {
            minimal.line_item = isPlainRecord(entry.line_item)
              ? {
                ...("variant_id" in entry.line_item ? { variant_id: keepId(entry.line_item.variant_id) } : {}),
                ...("product_id" in entry.line_item ? { product_id: keepId(entry.line_item.product_id) } : {}),
              }
              : false;
          }
          return minimal;
        })
        : false;
    }
    if ("transactions" in data) {
      out.transactions = Array.isArray(data.transactions)
        ? data.transactions.map((tx) => (isPlainRecord(tx)
          ? {
            ...("kind" in tx ? { kind: keepString(tx.kind) } : {}),
            ...("status" in tx ? { status: keepString(tx.status) } : {}),
            ...("amount" in tx ? { amount: keepId(tx.amount) } : {}),
            ...("currency" in tx ? { currency: keepString(tx.currency) } : {}),
          }
          : false))
        : false;
    }
    if ("refund_shipping_lines" in data) {
      out.refund_shipping_lines = Array.isArray(data.refund_shipping_lines)
        ? data.refund_shipping_lines.map((line) => {
          if (!isPlainRecord(line)) return false;
          const set = isPlainRecord(line.subtotal_amount_set) ? line.subtotal_amount_set : null;
          const shopMoney = set && isPlainRecord(set.shop_money) ? set.shop_money : null;
          return shopMoney
            ? {
              subtotal_amount_set: {
                shop_money: {
                  ...("amount" in shopMoney ? { amount: keepId(shopMoney.amount) } : {}),
                  ...("currency_code" in shopMoney ? { currency_code: keepString(shopMoney.currency_code) } : {}),
                },
              },
            }
            : false;
        })
        : false;
    }
    return out;
  }

  if (topic === "inventory_levels/update") {
    return "inventory_item_id" in data ? { inventory_item_id: keepId(data.inventory_item_id) } : {};
  }

  if (
    topic === "products/create"
    || topic === "products/update"
    || topic === "products/delete"
    || topic in RETURN_STATUS
    || topic.startsWith("orders/")
  ) {
    return "id" in data ? { id: keepId(data.id) } : {};
  }

  return {};
}

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
