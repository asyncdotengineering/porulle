import type { AppModule } from "../kernel/module/index.js";
import { topoSortModules } from "../kernel/module/index.js";
import { auditModule } from "../modules/audit/index.js";
import { analyticsModule } from "../modules/analytics/module.js";
import { cartModule } from "../modules/cart/module.js";
import { catalogModule } from "../modules/catalog/module.js";
import { customersModule } from "../modules/customers/index.js";
import { documentsModule } from "../modules/documents/module.js";
import { fulfillmentModule } from "../modules/fulfillment/module.js";
import { inventoryModule } from "../modules/inventory/module.js";
import { mediaModule } from "../modules/media/index.js";
import { ordersModule } from "../modules/orders/module.js";
import { organizationModule } from "../modules/organization/index.js";
import { paymentsModule } from "../modules/payments/module.js";
import { pricingModule } from "../modules/pricing/index.js";
import { promotionsModule } from "../modules/promotions/module.js";
import { searchModule } from "../modules/search/module.js";
import { settingsModule } from "../modules/settings/module.js";
import { shippingModule } from "../modules/shipping/module.js";
import { taxModule } from "../modules/tax/module.js";
import { webhooksModule } from "../modules/webhooks/index.js";

export const KERNEL_ALL_MODULES = {
  audit: auditModule,
  settings: settingsModule,
  documents: documentsModule,
  webhooks: webhooksModule,
  media: mediaModule,
  organization: organizationModule,
  customers: customersModule,
  pricing: pricingModule,
  catalog: catalogModule,
  inventory: inventoryModule,
  cart: cartModule,
  orders: ordersModule,
  fulfillment: fulfillmentModule,
  promotions: promotionsModule,
  search: searchModule,
  shipping: shippingModule,
  tax: taxModule,
  payments: paymentsModule,
  analytics: analyticsModule,
} as const;

/** Strip symmetric/lazy manifest edges so topo sort reflects constructor-safe ordering. */
export function kernelModulesForTopoSort(): Record<string, AppModule> {
  return {
    ...KERNEL_ALL_MODULES,
    catalog: { ...catalogModule, dependencies: [] },
    promotions: {
      ...promotionsModule,
      dependencies: ["catalog"],
    },
    orders: {
      ...ordersModule,
      dependencies: [
        "cart",
        "inventory",
        "payments",
        "pricing",
        "fulfillment",
        "tax",
      ],
    },
  } as unknown as Record<string, AppModule>;
}

export function kernelModuleInstantiationOrder(): readonly string[] {
  return topoSortModules(kernelModulesForTopoSort());
}
