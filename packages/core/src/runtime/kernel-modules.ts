import type { CommerceConfig } from "../config/types.js";
import type { DatabaseAdapter } from "../kernel/database/adapter.js";
import type { DrizzleDatabase } from "../kernel/database/drizzle-db.js";
import type { PluginDb } from "../kernel/database/plugin-types.js";
import type { HookRegistry } from "../kernel/hooks/registry.js";
import { extendOrderStateMachine } from "../kernel/state-machine/machine.js";
import { DrizzleAnalyticsAdapter } from "../modules/analytics/drizzle-adapter.js";
import { BUILTIN_ANALYTICS_MODELS } from "../modules/analytics/models.js";
import { RetailReportsEngine } from "../modules/analytics/reports.js";
import { AnalyticsService } from "../modules/analytics/service.js";
import { createAuditService } from "../modules/audit/service.js";
import { CartRepository } from "../modules/cart/repository/index.js";
import { CartService } from "../modules/cart/service.js";
import { CatalogRepository } from "../modules/catalog/repository/index.js";
import { CatalogServiceImpl } from "../modules/catalog/service.js";
import { CustomersRepository } from "../modules/customers/repository/index.js";
import { CustomerService } from "../modules/customers/service.js";
import { DocumentsRepository } from "../modules/documents/repository/index.js";
import { DocumentsService } from "../modules/documents/service.js";
import { FulfillmentRepository } from "../modules/fulfillment/repository/index.js";
import { FulfillmentService } from "../modules/fulfillment/service.js";
import { InventoryRepository } from "../modules/inventory/repository/index.js";
import { InventoryService } from "../modules/inventory/service.js";
import { MediaRepository } from "../modules/media/repository/index.js";
import { MediaService } from "../modules/media/service.js";
import { OrdersRepository } from "../modules/orders/repository/index.js";
import { OrderService } from "../modules/orders/service.js";
import { OrganizationService } from "../modules/organization/service.js";
import { PaymentsService } from "../modules/payments/service.js";
import { PricingRepository } from "../modules/pricing/repository/index.js";
import { PricingService } from "../modules/pricing/service.js";
import { PromotionsRepository } from "../modules/promotions/repository/index.js";
import { PromotionService } from "../modules/promotions/service.js";
import { SearchService } from "../modules/search/service.js";
import { SettingsRepository } from "../modules/settings/repository/index.js";
import { SettingsService } from "../modules/settings/service.js";
import { ShippingConfigRepository } from "../modules/shipping/repository/index.js";
import { ShippingService } from "../modules/shipping/service.js";
import { TaxRatesRepository } from "../modules/tax/repository/index.js";
import { TaxService } from "../modules/tax/service.js";
import { WebhooksRepository } from "../modules/webhooks/repository/index.js";
import { WebhookService } from "../modules/webhooks/service.js";

/** What every core service factory is built from. */
export interface ServiceFactoryDeps {
  database: DatabaseAdapter;
  db: DrizzleDatabase;
  hooks: HookRegistry;
  config: CommerceConfig;
  /** The services built so far, in the order below. A factory may read only those above it. */
  services: Record<string, unknown>;
}

type Built = {
  catalog: CatalogServiceImpl;
  inventory: InventoryService;
  settings: SettingsService;
};

const built = (deps: ServiceFactoryDeps) => deps.services as Built;

/**
 * The core services, in the order the kernel constructs them. A factory that
 * reads another service at construction (catalog's repository, the inventory
 * service) must come after it; services reached only at call time through
 * `deps.services` may sit anywhere.
 */
export const KERNEL_SERVICE_FACTORIES = [
  ["audit", (d: ServiceFactoryDeps) => createAuditService(d.db)],
  ["settings", (d: ServiceFactoryDeps) =>
    new SettingsService({ repository: new SettingsRepository(d.db), config: d.config })],
  ["documents", (d: ServiceFactoryDeps) =>
    new DocumentsService({ repository: new DocumentsRepository(d.db), services: d.services, config: d.config })],
  ["webhooks", (d: ServiceFactoryDeps) =>
    new WebhookService({ repository: new WebhooksRepository(d.db), config: d.config })],
  ["media", (d: ServiceFactoryDeps) => {
    if (d.config.storage == null) throw new Error("Media module requires config.storage");
    return new MediaService({
      repository: new MediaRepository(d.db),
      catalogRepository: new CatalogRepository(d.db),
      storage: d.config.storage,
      config: d.config,
      database: d.database,
      services: d.services,
    });
  }],
  ["organization", (d: ServiceFactoryDeps) => new OrganizationService(d.db)],
  ["customers", (d: ServiceFactoryDeps) =>
    new CustomerService({
      repository: new CustomersRepository(d.db),
      hooks: d.hooks,
      config: d.config,
      services: d.services,
      database: d.database,
    })],
  ["catalog", (d: ServiceFactoryDeps) =>
    new CatalogServiceImpl({
      repository: new CatalogRepository(d.db),
      hooks: d.hooks,
      config: d.config,
      services: d.services,
      database: d.database,
    })],
  ["tax", (d: ServiceFactoryDeps) =>
    new TaxService({
      adapter: d.config.tax?.adapter,
      repository: new TaxRatesRepository(d.db),
      config: d.config,
    })],
  ["payments", (d: ServiceFactoryDeps) => new PaymentsService(d.config.payments)],
  ["analytics", (d: ServiceFactoryDeps) => {
    const adapter = new DrizzleAnalyticsAdapter(d.db);
    for (const model of BUILTIN_ANALYTICS_MODELS) adapter.registerModel(model);
    // Settings is read at call time, not construction.
    const reports = new RetailReportsEngine(d.db, (orgId, group) => built(d).settings.read(orgId, group));
    return new AnalyticsService({ adapter, config: d.config, reports });
  }],
  ["pricing", (d: ServiceFactoryDeps) =>
    new PricingService({
      repository: new PricingRepository(d.db),
      catalogRepository: built(d).catalog.repository,
      hooks: d.hooks,
      config: d.config,
      services: d.services,
      database: d.database,
    })],
  ["inventory", (d: ServiceFactoryDeps) =>
    new InventoryService({
      repository: new InventoryRepository(d.db),
      hooks: d.hooks,
      config: d.config,
      services: d.services,
      database: d.database,
    })],
  ["promotions", (d: ServiceFactoryDeps) =>
    new PromotionService({
      repository: new PromotionsRepository(d.db),
      catalogRepository: built(d).catalog.repository,
      ordersRepository: new OrdersRepository(d.db),
      hooks: d.hooks,
      config: d.config,
      services: d.services,
      database: d.database,
    })],
  ["search", (d: ServiceFactoryDeps) => {
    const adapter = d.config.search?.adapter;
    adapter?.init?.({ db: d.db as PluginDb });
    const catalog = built(d).catalog;
    return new SearchService({
      catalogRepository: catalog.repository,
      resolveEntityFieldDefinitions: catalog.resolveEntityFieldDefinitions.bind(catalog),
      config: d.config,
      ...(d.config.entities ? { entities: d.config.entities } : {}),
      ...(adapter ? { adapter } : {}),
      ...(d.config.search?.defaultFacets ? { defaultFacets: d.config.search.defaultFacets } : {}),
    });
  }],
  ["shipping", (d: ServiceFactoryDeps) =>
    new ShippingService({
      config: d.config,
      catalogRepository: built(d).catalog.repository,
      repository: new ShippingConfigRepository(d.db),
    })],
  ["cart", (d: ServiceFactoryDeps) =>
    new CartService({
      repository: new CartRepository(d.db),
      catalogRepository: built(d).catalog.repository,
      hooks: d.hooks,
      config: d.config,
      services: d.services,
      database: d.database,
    })],
  ["fulfillment", (d: ServiceFactoryDeps) =>
    new FulfillmentService({
      repository: new FulfillmentRepository(d.db),
      ordersRepository: new OrdersRepository(d.db),
      inventoryService: built(d).inventory,
      hooks: d.hooks,
      config: d.config,
      services: d.services,
      database: d.database,
    })],
  ["orders", (d: ServiceFactoryDeps) =>
    new OrderService({
      repository: new OrdersRepository(d.db),
      hooks: d.hooks,
      config: d.config,
      services: d.services,
      database: d.database,
      ...(d.config.orders?.customTransitions
        ? { stateMachine: extendOrderStateMachine(d.config.orders.customTransitions) }
        : {}),
    })],
] as const;
