import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import { extendOrderStateMachine } from "../../kernel/state-machine/machine.js";
import type { CartService } from "../cart/service.js";
import type { FulfillmentService } from "../fulfillment/service.js";
import type { InventoryService } from "../inventory/service.js";
import type { PaymentsService } from "../payments/service.js";
import type { PricingService } from "../pricing/service.js";
import type { PromotionService } from "../promotions/service.js";
import type { TaxService } from "../tax/service.js";
import { OrdersRepository } from "./repository/index.js";
import {
  orderLineItems,
  orders,
  orderStatusHistory,
} from "./schema.js";
import { OrderService } from "./service.js";

type OrdersModuleDeps = {
  cart: CartService;
  inventory: InventoryService;
  payments: PaymentsService;
  pricing: PricingService;
  promotions: PromotionService;
  fulfillment: FulfillmentService;
  tax: TaxService;
};

export const ordersModule = defineModule<
  {
    orders: typeof orders;
    orderLineItems: typeof orderLineItems;
    orderStatusHistory: typeof orderStatusHistory;
  },
  OrderService,
  OrdersModuleDeps
>({
  id: "orders",
  dependencies: [
    "cart",
    "inventory",
    "payments",
    "pricing",
    "promotions",
    "fulfillment",
    "tax",
  ],
  schema: () => ({ orders, orderLineItems, orderStatusHistory }),
  service: (deps) => {
    const config = deps.config as CommerceConfig;
    return new OrderService({
      repository: new OrdersRepository(deps.db.db as DrizzleDatabase),
      hooks: deps.hooks,
      services: deps.services,
      database: deps.db,
      ...(config.orders?.customTransitions
        ? {
            stateMachine: extendOrderStateMachine(
              config.orders.customTransitions,
            ),
          }
        : {}),
    });
  },
});
