import type { Result } from "../../kernel/result.js";
import type { OrderLineItem } from "../orders/repository/index.js";

export interface FulfillmentRecord {
  id: string;
  orderId: string;
  lineItems: Array<{
    id: string;
    title: string;
    quantity: number;
    sku?: string;
  }>;
  type: string;
  status: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
  shippedAt?: string;
  deliveredAt?: string;
  downloadUrl?: string;
  downloadExpiresAt?: string;
  maxDownloads?: number;
  downloadCount?: number;
  customerId?: string;
  entityType?: string;
  entityId?: string;
  grantedAt?: string;
  expiresAt?: string;
  isActive?: boolean;
}

export interface FulfillmentStrategyContext {
  actorId?: string;
}

export type FulfillmentLineItem = Pick<
  OrderLineItem,
  "id" | "entityId" | "entityType" | "sku" | "title" | "quantity"
> & {
  orderId: string;
  customerId?: string;
};

export interface FulfillmentStrategy {
  type: string;
  canFulfill(
    lineItem: FulfillmentLineItem,
    context: FulfillmentStrategyContext,
  ): Promise<Result<boolean>>;
  fulfill(
    lineItem: FulfillmentLineItem,
    context: FulfillmentStrategyContext,
  ): Promise<Result<FulfillmentRecord>>;
  reverse(
    fulfillmentId: string,
    context: FulfillmentStrategyContext,
  ): Promise<Result<void>>;
}
