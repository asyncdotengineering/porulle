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

export interface ChannelCatalogVariant {
  externalId: string;
  sku?: string;
  barcode?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelCatalogItem {
  externalId: string;
  slug: string;
  title: string;
  description?: string;
  variants: ChannelCatalogVariant[];
  metadata?: Record<string, unknown>;
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
  return connector;
}
