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
  status: "connected" | "disconnected" | "error";
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
  /** What the shopper paid for this slice: its lines, plus `shipping` when present. */
  grandTotal: number;
  lines: ChannelOrderLine[];
  /**
   * The order's delivery charge, present only when the slice is the whole order and the charge is
   * above zero. An order split across stores carries none: one charge cannot be divided honestly.
   */
  shipping?: { title: string; amount: number };
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

export interface ChannelWebhookEvent {
  id: string;
  type: string;
  data: unknown;
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
    ctx: { storeDomain: string },
  ): Promise<Result<{ credentials: Record<string, unknown>; storeDomain: string }, ChannelConnectorError>>;
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
  /** A delivery to the per-store address, for providers that sign per store (WooCommerce). */
  verifyWebhook?(store: ChannelStore, request: Request): Promise<Result<ChannelWebhookEvent>>;
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
