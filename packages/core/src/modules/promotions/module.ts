import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import type { CatalogServiceImpl } from "../catalog/service.js";
import type { OrderService } from "../orders/service.js";
import { OrdersRepository } from "../orders/repository/index.js";
import { PromotionsRepository } from "./repository/index.js";
import { promotionUsages, promotions } from "./schema.js";
import { PromotionService } from "./service.js";

type PromotionsModuleDeps = {
  catalog: CatalogServiceImpl;
  orders: OrderService;
};

export const promotionsModule = defineModule<
  { promotions: typeof promotions; promotionUsages: typeof promotionUsages },
  PromotionService,
  PromotionsModuleDeps
>({
  id: "promotions",
  dependencies: ["catalog", "orders"],
  schema: () => ({ promotions, promotionUsages }),
  service: (deps) =>
    new PromotionService({
      repository: new PromotionsRepository(deps.db.db as DrizzleDatabase),
      catalogRepository: deps.services.catalog.repository,
      ordersRepository: new OrdersRepository(deps.db.db as DrizzleDatabase),
      hooks: deps.hooks,
      services: deps.services,
      database: deps.db,
    }),
});
