import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { HookRegistry } from "../src/kernel/hooks/registry.js";
import type { ModuleDeps } from "../src/kernel/module/index.js";
import { analyticsModule } from "../src/modules/analytics/module.js";
import { AnalyticsService } from "../src/modules/analytics/service.js";
import { cartModule } from "../src/modules/cart/module.js";
import { CartService } from "../src/modules/cart/service.js";
import { CatalogRepository } from "../src/modules/catalog/repository/index.js";
import { catalogModule } from "../src/modules/catalog/module.js";
import { fulfillmentModule } from "../src/modules/fulfillment/module.js";
import { FulfillmentService } from "../src/modules/fulfillment/service.js";
import { inventoryModule } from "../src/modules/inventory/module.js";
import { InventoryService } from "../src/modules/inventory/service.js";
import { OrderService } from "../src/modules/orders/service.js";
import { ordersModule } from "../src/modules/orders/module.js";
import { paymentsModule } from "../src/modules/payments/module.js";
import { PaymentsService } from "../src/modules/payments/service.js";
import { pricingModule } from "../src/modules/pricing/index.js";
import { PricingService } from "../src/modules/pricing/service.js";
import { PromotionService } from "../src/modules/promotions/service.js";
import { promotionsModule } from "../src/modules/promotions/module.js";
import { searchModule } from "../src/modules/search/module.js";
import { SearchService } from "../src/modules/search/service.js";
import { shippingModule } from "../src/modules/shipping/module.js";
import { ShippingService } from "../src/modules/shipping/service.js";
import { TaxService } from "../src/modules/tax/service.js";
import { taxModule } from "../src/modules/tax/module.js";

function tier3Deps<TDeps extends Record<string, unknown> = Record<string, unknown>>(
  services: TDeps,
): ModuleDeps<TDeps> {
  const adapter: DatabaseAdapter = {
    provider: "test",
    db: {} as DrizzleDatabase,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
  };
  return {
    db: adapter,
    hooks: new HookRegistry(),
    services,
    config: {},
    logger,
  };
}

function acceptCart(s: CartService) {
  return s;
}
function acceptInventory(s: InventoryService) {
  return s;
}
function acceptPricing(s: PricingService) {
  return s;
}
function acceptPayments(s: PaymentsService) {
  return s;
}
function acceptTax(s: TaxService) {
  return s;
}
function acceptOrder(s: OrderService) {
  return s;
}
function acceptFulfillment(s: FulfillmentService) {
  return s;
}
function acceptPromotion(s: PromotionService) {
  return s;
}
function acceptSearch(s: SearchService) {
  return s;
}
function acceptShipping(s: ShippingService) {
  return s;
}
function acceptAnalytics(s: AnalyticsService) {
  return s;
}

describe("tier-3 defineModule", () => {
  it("cartModule declares catalog and inventory and wires CartService", () => {
    expect(cartModule.id).toBe("cart");
    expect(cartModule.dependencies).toEqual(["catalog", "inventory"]);

    const catalogRepo = new CatalogRepository({} as DrizzleDatabase);
    const pricing = pricingModule.service(
      tier3Deps({
        catalog: { repository: catalogRepo },
      }),
    );
    acceptPricing(pricing);
    const catalog = catalogModule.service(tier3Deps({ pricing }));
    const inventory = inventoryModule.service(tier3Deps({ catalog }));
    acceptInventory(inventory);

    const deps = tier3Deps({ catalog, inventory });
    acceptInventory(deps.services.inventory);
    const cart = cartModule.service(deps);
    acceptCart(cart);
    expect(cart).toBeInstanceOf(CartService);
  });

  it("ordersModule declares service deps and wires OrderService", () => {
    expect(ordersModule.id).toBe("orders");
    expect(ordersModule.dependencies).toEqual([
      "cart",
      "inventory",
      "payments",
      "pricing",
      "promotions",
      "fulfillment",
      "tax",
    ]);

    const catalogRepo = new CatalogRepository({} as DrizzleDatabase);
    const pricing = pricingModule.service(
      tier3Deps({
        catalog: { repository: catalogRepo },
      }),
    );
    const catalog = catalogModule.service(tier3Deps({ pricing }));
    const inventory = inventoryModule.service(tier3Deps({ catalog }));

    const payments = paymentsModule.service(tier3Deps({}));
    acceptPayments(payments);
    const tax = taxModule.service(tier3Deps({}));
    acceptTax(tax);

    const ordersDepValues = {
      cart: {} as CartService,
      inventory,
      payments,
      pricing,
      promotions: {} as PromotionService,
      fulfillment: {} as FulfillmentService,
      tax,
    };
    const od = tier3Deps(ordersDepValues);
    acceptInventory(od.services.inventory);
    acceptPayments(od.services.payments);
    acceptTax(od.services.tax);

    const orders = ordersModule.service(od);
    acceptOrder(orders);
    expect(orders).toBeInstanceOf(OrderService);
  });

  it("fulfillmentModule declares inventory and wires FulfillmentService", () => {
    expect(fulfillmentModule.id).toBe("fulfillment");
    expect(fulfillmentModule.dependencies).toEqual(["inventory"]);

    const catalogRepo = new CatalogRepository({} as DrizzleDatabase);
    const pricing = pricingModule.service(
      tier3Deps({
        catalog: { repository: catalogRepo },
      }),
    );
    const catalog = catalogModule.service(tier3Deps({ pricing }));
    const inventory = inventoryModule.service(tier3Deps({ catalog }));

    const fd = tier3Deps({ inventory });
    acceptInventory(fd.services.inventory);
    const fulfillment = fulfillmentModule.service(fd);
    acceptFulfillment(fulfillment);
    expect(fulfillment).toBeInstanceOf(FulfillmentService);
  });

  it("promotionsModule declares catalog and orders and wires PromotionService", () => {
    expect(promotionsModule.id).toBe("promotions");
    expect(promotionsModule.dependencies).toEqual(["catalog", "orders"]);

    const catalogRepo = new CatalogRepository({} as DrizzleDatabase);
    const pricing = pricingModule.service(
      tier3Deps({
        catalog: { repository: catalogRepo },
      }),
    );
    const catalog = catalogModule.service(tier3Deps({ pricing }));

    const fakeOrders = {} as OrderService;
    const pd = tier3Deps({ catalog, orders: fakeOrders });
    expect(pd.services.catalog.repository).toBeDefined();

    const promotions = promotionsModule.service(pd);
    acceptPromotion(promotions);
    expect(promotions).toBeInstanceOf(PromotionService);
  });

  it("searchModule declares catalog and wires SearchService", () => {
    expect(searchModule.id).toBe("search");
    expect(searchModule.dependencies).toEqual(["catalog"]);

    const catalogRepo = new CatalogRepository({} as DrizzleDatabase);
    const pricing = pricingModule.service(
      tier3Deps({
        catalog: { repository: catalogRepo },
      }),
    );
    const catalog = catalogModule.service(tier3Deps({ pricing }));

    const sd = tier3Deps({ catalog });
    const search = searchModule.service(sd);
    acceptSearch(search);
    expect(search).toBeInstanceOf(SearchService);
  });

  it("shippingModule declares catalog and wires ShippingService", () => {
    expect(shippingModule.id).toBe("shipping");
    expect(shippingModule.dependencies).toEqual(["catalog"]);

    const catalogRepo = new CatalogRepository({} as DrizzleDatabase);
    const pricing = pricingModule.service(
      tier3Deps({
        catalog: { repository: catalogRepo },
      }),
    );
    const catalog = catalogModule.service(tier3Deps({ pricing }));

    const sh = shippingModule.service(tier3Deps({ catalog }));
    acceptShipping(sh);
    expect(sh).toBeInstanceOf(ShippingService);
  });

  it("taxModule wires TaxService", () => {
    expect(taxModule.id).toBe("tax");
    const tax = taxModule.service(tier3Deps({}));
    acceptTax(tax);
    expect(tax).toBeInstanceOf(TaxService);
  });

  it("paymentsModule wires PaymentsService", () => {
    expect(paymentsModule.id).toBe("payments");
    const payments = paymentsModule.service(tier3Deps({}));
    acceptPayments(payments);
    expect(payments).toBeInstanceOf(PaymentsService);
  });

  it("analyticsModule wires AnalyticsService", () => {
    expect(analyticsModule.id).toBe("analytics");
    const analytics = analyticsModule.service(tier3Deps({}));
    acceptAnalytics(analytics);
    expect(analytics).toBeInstanceOf(AnalyticsService);
  });
});
