import type {
  CommerceConfig,
  PluginPermission,
} from "../config/types.js";
import type { HookRegistry } from "../kernel/hooks/registry.js";
import type { DatabaseAdapter } from "../kernel/database/adapter.js";
import { CatalogServiceImpl } from "../modules/catalog/service.js";
import { InventoryService } from "../modules/inventory/service.js";
import { MediaService } from "../modules/media/service.js";
import { CartService } from "../modules/cart/service.js";
import { OrderService } from "../modules/orders/service.js";
import { PaymentsService } from "../modules/payments/service.js";
import { FulfillmentService } from "../modules/fulfillment/service.js";
import { CustomerService } from "../modules/customers/service.js";
import { WebhookService } from "../modules/webhooks/service.js";
import { AnalyticsService } from "../modules/analytics/service.js";
import { PricingService } from "../modules/pricing/service.js";
import { PromotionService } from "../modules/promotions/service.js";
import { TaxService } from "../modules/tax/service.js";
import { ShippingService } from "../modules/shipping/service.js";
import { SearchService } from "../modules/search/service.js";
import { SettingsService } from "../modules/settings/service.js";
import { DocumentsService } from "../modules/documents/service.js";
import type { AuditService } from "../modules/audit/service.js";
import { OrganizationService } from "../modules/organization/service.js";
import { createLogger } from "../utils/logger.js";
import { CompensationFailuresRepository } from "../kernel/compensation/repository.js";

export interface WebhookDeliveryPayload {
  endpoint: { id: string; url: string; secret: string };
  eventName: string;
  payload: unknown;
}

export interface Kernel {
  config: CommerceConfig;
  hooks: HookRegistry;
  database: DatabaseAdapter;
  services: {
    catalog: CatalogServiceImpl;
    inventory: InventoryService;
    media: MediaService;
    cart: CartService;
    orders: OrderService;
    payments: PaymentsService;
    fulfillment: FulfillmentService;
    customers: CustomerService;
    webhooks: WebhookService & {
      enqueueDelivery(payload: WebhookDeliveryPayload): Promise<void>;
    };
    analytics: AnalyticsService;
    pricing: PricingService;
    promotions: PromotionService;
    tax: TaxService;
    shipping: ShippingService;
    search: SearchService;
    settings: SettingsService;
    documents: DocumentsService;
    audit: AuditService;
    compensationFailures: CompensationFailuresRepository;
    email: CommerceConfig["email"];
    organization: OrganizationService;
  };
  pluginPermissions: PluginPermission[];
  logger: ReturnType<typeof createLogger>;
}

export const KERNEL_REQUIRED_SERVICE_KEYS = [
  "catalog",
  "inventory",
  "media",
  "cart",
  "orders",
  "payments",
  "fulfillment",
  "customers",
  "webhooks",
  "analytics",
  "pricing",
  "promotions",
  "tax",
  "shipping",
  "search",
  "settings",
  "documents",
  "audit",
  "compensationFailures",
] as const satisfies Array<keyof Kernel["services"]>;

export function assertKernelServicesReady(
  services: Partial<Kernel["services"]>,
): asserts services is Kernel["services"] {
  for (const key of KERNEL_REQUIRED_SERVICE_KEYS) {
    if (services[key] === undefined) {
      throw new Error(`Kernel service "${String(key)}" was not initialized.`);
    }
  }
}

export function assertSortedBefore(
  topo: readonly string[],
  a: string,
  b: string,
): void {
  const ia = topo.indexOf(a);
  const ib = topo.indexOf(b);
  if (ia < 0 || ib < 0) {
    throw new Error(`kernelModuleInstantiationOrder missing key: ${a} or ${b}`);
  }
  if (ia >= ib) {
    throw new Error(
      `Invalid kernel topo order: expected "${a}" before "${b}" (indices ${ia}, ${ib})`,
    );
  }
}
