import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import type { CatalogServiceImpl } from "../catalog/service.js";
import type { InventoryService } from "../inventory/service.js";
import { CartRepository } from "./repository/index.js";
import { cartLineItems, carts } from "./schema.js";
import { CartService } from "./service.js";

type CartModuleDeps = {
  catalog: CatalogServiceImpl;
  inventory: InventoryService;
};

export const cartModule = defineModule<
  { carts: typeof carts; cartLineItems: typeof cartLineItems },
  CartService,
  CartModuleDeps
>({
  id: "cart",
  dependencies: ["catalog", "inventory"],
  schema: () => ({ carts, cartLineItems }),
  service: (deps) =>
    new CartService({
      repository: new CartRepository(deps.db.db as DrizzleDatabase),
      catalogRepository: deps.services.catalog.repository,
      hooks: deps.hooks,
      config: deps.config as CommerceConfig,
      services: deps.services,
      database: deps.db,
    }),
});
