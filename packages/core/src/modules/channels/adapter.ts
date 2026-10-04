import type { Result } from "../../kernel/result.js";

export interface ChannelConnectorError {
  code: string;
  message: string;
  retriable?: boolean;
}

/**
 * The code a connector answers when the provider REJECTED the credentials a call presented — an
 * access token revoked, rotated, or retired before its stated expiry. The channel service answers it
 * with one forced `liveCredentials` refresh and one retry; only when that fails is the store marked
 * for reconnection.
 */
export const CHANNEL_CREDENTIALS_REJECTED = "CHANNEL_CREDENTIALS_REJECTED";

export interface ChannelConnectorCapabilities {
  readonly importCatalog: boolean;
  readonly importInventory: boolean;
  readonly pushOrder: boolean;
  readonly pushCatalog?: boolean;
  readonly receiveWebhooks: boolean;
  readonly reserve?: boolean;
}

export interface ChannelStore {
  id: string;
  organizationId: string;
  provider: string;
  credentials: Record<string, unknown>;
  storeDomain: string;
  /** `connecting`: credentials are stored and the follow-on work (verify, subscribe, first import) is still running. */
  status: "connecting" | "connected" | "disconnected" | "error";
  webhookSecret: string | null;
}

export interface ChannelCatalogLocalizedAttributes {
  locale: string;
  title: string;
  subtitle?: string;
  description?: string;
  richDescription?: unknown;
  seoTitle?: string;
  seoDescription?: string;
}

export interface ChannelCatalogImage {
  externalId?: string;
  url: string;
  alt?: string;
  role: "primary" | "gallery" | "thumbnail" | "video" | "document";
  sortOrder?: number;
  variantExternalIds?: string[];
}

export interface ChannelCatalogOptionType {
  name: string;
  displayName: string;
  sortOrder?: number;
  values: Array<{
    value: string;
    displayValue: string;
    sortOrder?: number;
  }>;
}

export interface ChannelCatalogPrice {
  currency: string;
  amount: number;
  compareAtAmount?: number;
}

export interface ChannelCatalogVariant {
  externalId: string;
  sku?: string;
  barcode?: string;
  metadata?: Record<string, unknown>;
  optionValues?: Record<string, string>;
  prices?: ChannelCatalogPrice[];
}

export interface ChannelCatalogItem {
  externalId: string;
  slug: string;
  title: string;
  description?: string;
  variants: ChannelCatalogVariant[];
  metadata?: Record<string, unknown>;
  attributes?: ChannelCatalogLocalizedAttributes[];
  images?: ChannelCatalogImage[];
  options?: ChannelCatalogOptionType[];
  tags?: string[];
  brand?: string;
  categories?: string[];
  status?: "draft" | "active" | "archived" | "discontinued";
  /** The product's page on the merchant's own storefront, as the provider reports it. Never inferred. */
  storefrontUrl?: string;
}

export interface ChannelCatalogPage {
  items: ChannelCatalogItem[];
  nextCursor?: string | null;
}

export interface ChannelInventoryLevel {
  externalId: string;
  available: number;
}

export interface ChannelOrderLine {
  externalVariantId: string;
  sku?: string;
  title: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

/** Where an order ships, in no provider's spelling; each connector maps it to its own. */
export interface ChannelOrderAddress {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  /** A province or state: its code where the shopper's country has one, else as typed. */
  region?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  phone?: string;
}

export interface ChannelOrderSlice {
  orderId: string;
  currency: string;
  /** What the shopper paid for this slice: its lines, plus `shipping`, minus `discount`, when present. */
  grandTotal: number;
  lines: ChannelOrderLine[];
  /**
   * The order's delivery charge, present only when the slice is the whole order and the charge is
   * above zero. An order split across stores carries none: one charge cannot be divided honestly.
   */
  shipping?: { title: string; amount: number };
  /**
   * The order's discount, present only when the slice is the whole order and the discount is above
   * zero, named by the code the shopper used (or `DISCOUNT` for one applied without a code). The
   * slice's `grandTotal` already has it taken off, so the store's total is what the shopper paid.
   */
  discount?: { code: string; amount: number };
  customer: {
    name: string;
    email: string;
    shippingAddress: ChannelOrderAddress;
  };
}

export interface ChannelPushOrderResult {
  remoteOrderId: string;
  remoteUrl?: string;
}

export type ChannelPushCatalogIntent = "filterable" | "display" | "tag";

export interface ChannelPushCatalogField {
  fieldPath: string;
  intent: ChannelPushCatalogIntent;
  value: unknown;
  locale?: string;
  remoteKey?: string;
}

export interface ChannelPushCatalogImage {
  externalId?: string;
  url: string;
  alt?: string;
  role: "primary" | "gallery" | "thumbnail" | "video" | "document";
  sortOrder?: number;
  variantExternalIds?: string[];
}

export interface ChannelPushCatalogVariant {
  externalId: string;
  fields: ChannelPushCatalogField[];
}

export interface ChannelPushCatalogItem {
  externalId: string;
  variants?: ChannelPushCatalogVariant[];
  fields: ChannelPushCatalogField[];
  images?: ChannelPushCatalogImage[];
}

export interface ChannelPushCatalogPreviousField {
  fieldPath: string;
  value: unknown;
}

export interface ChannelPushCatalogImageOutcome {
  url: string;
  role: ChannelPushCatalogImage["role"];
  ok: boolean;
  externalId?: string;
  error?: ChannelConnectorError;
}

export interface ChannelPushCatalogItemOutcome {
  externalId: string;
  ok: boolean;
  error?: ChannelConnectorError;
  remoteUpdatedAt?: string;
  previousFields?: ChannelPushCatalogPreviousField[];
  images?: ChannelPushCatalogImageOutcome[];
}

export interface ChannelPushCatalogResult {
  outcomes: ChannelPushCatalogItemOutcome[];
}

export interface ChannelOrderStatus {
  status: "pending" | "confirmed" | "failed" | "cancelled" | "fulfilled";
}

/** Why an order is being cancelled at the provider. Providers that keep no reason ignore it. */
export type ChannelCancelReason = "customer" | "inventory" | "declined" | "fraud" | "staff" | "other";

export interface ChannelCancelOrderInput {
  reason: ChannelCancelReason;
  /** Shown to the merchant's staff, never to the customer. */
  staffNote?: string;
}

/**
 * The code a connector answers when the provider REFUSED to cancel — typically because the order has
 * already shipped. It is the merchant's answer, not a fault, so the caller must not cancel its own
 * side either.
 */
export const CHANNEL_CANCEL_REFUSED = "CHANNEL_CANCEL_REFUSED";

/**
 * The code a connector answers when the provider refused an order because it does not have the stock.
 * Definitive: nobody will send those goods, so the caller should cancel its own order rather than
 * leave a paid order waiting on a store that has said no.
 */
export const CHANNEL_OUT_OF_STOCK = "CHANNEL_OUT_OF_STOCK";

/** A shopper asking the store to take items back, each named by the store's own variant id. */
export interface ChannelReturnInput {
  lines: Array<{ externalVariantId: string; quantity: number }>;
  /** Why, in the shopper's words. Providers that keep a reason code receive it as a note. */
  reason: string;
  note?: string;
}

/**
 * A refund the marketplace already paid the shopper, booked at the store so its books and stock match
 * (a return the platform approved for a store with no returns of its own). Money is minor units.
 */
export interface ChannelRefundRecord {
  lines: Array<{ externalVariantId: string; quantity: number; amount: number }>;
  amount: number;
  reason: string;
  restock: boolean;
}

export interface ChannelReturnResult {
  /** The provider's id for the return: what its return webhooks name. */
  remoteReturnId: string;
}

export interface ChannelWebhookEvent {
  /**
   * The connector's idempotency key for this delivery, unique within one store and stable across
   * the provider's retries of it. The plugin deduplicates on it per store, never across stores.
   */
  id: string;
  type: string;
  data: unknown;
}

/** One parcel the store shipped, in no provider's spelling. */
export interface ChannelShipment {
  /** The store's id for the parcel: recording the same parcel twice records it once. */
  remoteId: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  /** What the parcel holds, by the store's variant id. Empty when the store does not say. */
  lines: Array<{ externalVariantId: string; quantity: number }>;
  /** Where the tracking was read, for a provider with more than one source. */
  source?: string;
}

/**
 * What a store delivery MEANS, decoded by the connector that speaks the provider's language. The
 * channel plugin acts on these and on nothing provider-shaped: a topic string or a payload field
 * never reaches it. A connector reads fresh from the store where the delivery is only a nudge, so
 * every event carries the store's current state, not a stale payload.
 */
export type ChannelEvent =
  | { kind: "product.changed"; externalIds: string[] }
  | { kind: "product.deleted"; externalIds: string[] }
  /** Stock read fresh from the store, per variant id (a simple product's own id when it has no variants). */
  | { kind: "inventory.changed"; levels: ChannelInventoryLevel[] }
  | { kind: "order.cancelled"; remoteOrderId: string }
  | { kind: "order.fulfilled"; remoteOrderId: string; partial: boolean; shipments: ChannelShipment[] }
  /**
   * Lines the merchant refunded at the store; the platform prices them from its own order. `amount` is
   * what the store says it refunded, in minor units, when it says: a refund for PART of a line, or a line
   * the store discounted, is less than the platform's price, and the platform never pays back more.
   */
  | { kind: "refund.created"; remoteOrderId: string; remoteRefundId: string; lines: Array<{ externalVariantId: string; quantity: number }>; amount?: number }
  | { kind: "return.updated"; remoteReturnId: string; status: "approved" | "declined" | "closed" | "cancelled" }
  | { kind: "connection.revoked" }
  | { kind: "compliance.request"; request: "customer_data" | "customer_redact" | "shop_redact"; data: Record<string, unknown> };

/**
 * The code a connector answers when the store accepted an order at a total other than what the
 * shopper paid. The connector has already cancelled that store order; the export fails visibly.
 */
export const CHANNEL_TOTAL_MISMATCH = "CHANNEL_TOTAL_MISMATCH";

/** What a connector found when it checked a store's webhook subscriptions, after repairing what it could. */
export interface ChannelWebhookHealth {
  /** Every expected topic is subscribed and active now (after repair). */
  healthy: boolean;
  /** Subscriptions recreated because they were missing, paused or disabled. */
  repaired: number;
  /** Topics still not subscribed after the attempt. */
  missing: string[];
}

/** A delivery to the provider's ONE app-level webhook address, naming the store it concerns. */
export interface ChannelAppWebhookEvent {
  /** Unique per delivery and stable across the provider's retries of it: the deduplication key. */
  id: string;
  topic: string;
  shopDomain: string;
  data: unknown;
}

/** What the provider says about the store itself, read with the credentials the merchant granted. */
export interface ChannelStoreProfile {
  name: string;
  /** ISO 4217: the currency the store prices its catalogue in. */
  currency: string;
  /** Hosts that serve this store's own storefront, attested by the provider. Lower-case. */
  storefrontHosts: string[];
}

export interface ChannelReservation {
  id: string;
  expiresAt?: Date;
}

export interface ChannelRefundResult {
  remoteRefundId: string;
  status: string;
}

export interface ChannelConnector {
  readonly providerId: string;
  readonly capabilities: ChannelConnectorCapabilities;
  buildAuthUrl?(params: {
    storeDomain: string;
    state: string;
    redirectUri: string;
    callbackUri: string;
    scopes: string[];
  }): Result<string, ChannelConnectorError>;
  completeAuth?(
    request: Request,
    /** `state` is the value `buildAuthUrl` was given, for a provider that echoes it back in the callback body. */
    ctx: { storeDomain: string; state: string },
  ): Promise<Result<{ credentials: Record<string, unknown>; storeDomain: string }, ChannelConnectorError>>;
  /**
   * Checks, before the merchant is sent anywhere, that what they typed is a store this connector can
   * connect — and says precisely what is wrong when it is not (not https, not this platform, a
   * firewall in front of it, its API switched off). Answers the canonical store address on success.
   */
  probeStore?(input: string): Promise<Result<{ storeDomain: string; name: string }, ChannelConnectorError>>;
  /**
   * The canonical spelling of what a merchant typed to name their store, or undefined when it cannot
   * name one. OAuth start runs the input through this before anything is signed or redirected.
   */
  normalizeStoreDomain?(input: string): string | undefined;
  /**
   * Credentials good for the next call: `null` when the stored ones are, new ones when the
   * connector refreshed an expiring grant. The channel service calls this before every connector
   * call that takes a store and persists what it returns, so no call starts on a lapsed token. A
   * non-retriable error means the grant is gone and the merchant must reconnect.
   */
  liveCredentials?(store: ChannelStore, options?: { force?: boolean }): Promise<Result<Record<string, unknown> | null, ChannelConnectorError>>;
  fetchStoreProfile?(store: ChannelStore): Promise<Result<ChannelStoreProfile, ChannelConnectorError>>;
  importCatalog(store: ChannelStore, cursor?: string): Promise<Result<ChannelCatalogPage>>;
  /**
   * The current state of the named products, read fresh. A webhook is a notification, not a
   * snapshot: its payload is in the provider's wire spelling and can arrive out of order, so a
   * product change is applied from this read. An id the provider no longer has is absent.
   */
  fetchCatalogItems?(store: ChannelStore, externalIds: string[]): Promise<Result<ChannelCatalogItem[], ChannelConnectorError>>;
  fetchInventory(store: ChannelStore, ids?: string[]): Promise<Result<ChannelInventoryLevel[]>>;
  /**
   * One page of the store's inventory, starting at `cursor` (null for the first page), with the
   * cursor of the next page or null on the last. The store's inventory sync takes one page per
   * step through this; a connector without it is synced by re-reading `fetchInventory` whole on
   * every step, which is O(levels²) per sync.
   */
  fetchInventoryPage?(store: ChannelStore, cursor: string | null): Promise<Result<{ levels: ChannelInventoryLevel[]; nextCursor: string | null }>>;
  pushOrder(store: ChannelStore, slice: ChannelOrderSlice): Promise<Result<ChannelPushOrderResult, ChannelConnectorError>>;
  pushCatalog?(
    store: ChannelStore,
    items: ChannelPushCatalogItem[],
    opts?: { dryRun?: boolean },
  ): Promise<Result<ChannelPushCatalogResult, ChannelConnectorError>>;
  fetchOrderStatus(store: ChannelStore, remoteId: string): Promise<Result<ChannelOrderStatus, ChannelConnectorError>>;
  /**
   * Cancel an order this connector pushed, restocking it at the store and refunding nothing there:
   * the marketplace holds the shopper's payment and refunds it itself. A provider that refuses
   * answers `CHANNEL_CANCEL_REFUSED`; an order already cancelled at the provider is success.
   */
  cancelOrder?(store: ChannelStore, remoteId: string, input: ChannelCancelOrderInput): Promise<Result<void, ChannelConnectorError>>;
  /** Ask the store to take items of a pushed order back. The store then approves or declines it. */
  requestReturn?(store: ChannelStore, remoteOrderId: string, input: ChannelReturnInput): Promise<Result<ChannelReturnResult, ChannelConnectorError>>;
  /**
   * Book a refund the marketplace paid at the store, moving no money there. A connector with this and
   * no `requestReturn` gets returns held on the platform and approved by the merchant there.
   */
  recordRefund?(store: ChannelStore, remoteOrderId: string, input: ChannelRefundRecord): Promise<Result<{ remoteRefundId: string }, ChannelConnectorError>>;
  /**
   * A delivery to the per-store address, for providers that sign per store (WooCommerce). `Ok(null)`
   * is a delivery that carries nothing to act on and must be answered 200 without verification,
   * such as the unsigned ping a provider sends when a subscription is created.
   */
  verifyWebhook?(store: ChannelStore, request: Request): Promise<Result<ChannelWebhookEvent | null>>;
  /**
   * What a verified delivery means. May read the store (a delivery is a nudge, not a snapshot). An
   * empty list is a delivery this connector does not act on; the plugin logs it as unmapped.
   */
  decodeWebhook?(store: ChannelStore, event: ChannelWebhookEvent): Promise<Result<ChannelEvent[], ChannelConnectorError>>;
  /** The topics `registerWebhooks` subscribes a store to, in the provider's own spelling. */
  readonly webhookTopics?: readonly string[];
  /**
   * The store's current state of an order this connector pushed, as the events a delivery about it
   * would decode to. A read point uses it to catch up an order whose delivery never arrived.
   */
  orderEvents?(store: ChannelStore, remoteOrderId: string): Promise<Result<ChannelEvent[], ChannelConnectorError>>;
  /** Removes every subscription this connector made for the store at `callbackUrl`. Best effort on disconnect. */
  unregisterWebhooks?(store: ChannelStore, callbackUrl: string): Promise<Result<{ removed: number }, ChannelConnectorError>>;
  /**
   * Checks the store's subscriptions to `callbackUrl` against `webhookTopics` and recreates any that
   * are missing, paused or disabled, signed with the store's existing secret. A rejected credential
   * answers `CHANNEL_CREDENTIALS_REJECTED`.
   */
  webhookHealth?(store: ChannelStore, callbackUrl: string): Promise<Result<ChannelWebhookHealth, ChannelConnectorError>>;
  /** A delivery to the provider-wide address, for providers that sign per app (Shopify). */
  verifyAppWebhook?(request: Request): Promise<Result<ChannelAppWebhookEvent, ChannelConnectorError>>;
  /** Called on connect with an ABSOLUTE callback URL, for providers that subscribe each store separately. */
  registerWebhooks?(
    store: ChannelStore,
    topics: string[],
    callbackUrl: string,
  ): Promise<Result<{ registered: number }, ChannelConnectorError>>;
  reserve?(
    store: ChannelStore,
    lines: ChannelOrderLine[],
  ): Promise<Result<ChannelReservation>>;
  refundExecute(
    store: ChannelStore,
    slice: ChannelOrderSlice,
    amount: number,
  ): Promise<Result<ChannelRefundResult>>;
}

export function defineChannelConnector<T extends ChannelConnector>(connector: T): T {
  if (connector.capabilities.pushCatalog !== undefined) return connector;
  return {
    ...connector,
    capabilities: {
      ...connector.capabilities,
      pushCatalog: false,
    },
  } as T;
}
