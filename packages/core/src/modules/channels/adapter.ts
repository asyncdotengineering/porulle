import type { Result } from "../../kernel/result.js";

export interface ChannelConnectorError {
  code: string;
  message: string;
  retriable?: boolean;
}

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

export interface ChannelOrderSlice {
  orderId: string;
  currency: string;
  grandTotal: number;
  lines: ChannelOrderLine[];
  customer: {
    name: string;
    email: string;
    shippingAddress: Record<string, unknown>;
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

export interface ChannelWebhookEvent {
  id: string;
  type: string;
  data: unknown;
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
  importCatalog(store: ChannelStore, cursor?: string): Promise<Result<ChannelCatalogPage>>;
  fetchInventory(store: ChannelStore, ids?: string[]): Promise<Result<ChannelInventoryLevel[]>>;
  pushOrder(store: ChannelStore, slice: ChannelOrderSlice): Promise<Result<ChannelPushOrderResult, ChannelConnectorError>>;
  pushCatalog?(
    store: ChannelStore,
    items: ChannelPushCatalogItem[],
    opts?: { dryRun?: boolean },
  ): Promise<Result<ChannelPushCatalogResult, ChannelConnectorError>>;
  fetchOrderStatus(store: ChannelStore, remoteId: string): Promise<Result<ChannelOrderStatus, ChannelConnectorError>>;
  verifyWebhook(store: ChannelStore, request: Request): Promise<Result<ChannelWebhookEvent>>;
  verifyAppWebhook?(
    request: Request,
  ): Promise<Result<{ topic: string; shopDomain: string; data: unknown }, ChannelConnectorError>>;
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
