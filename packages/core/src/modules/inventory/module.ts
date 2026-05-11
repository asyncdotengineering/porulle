import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import type { CatalogServiceImpl } from "../catalog/service.js";
import { InventoryRepository } from "./repository/index.js";
import { inventoryLevels, inventoryMovements, warehouses } from "./schema.js";
import { InventoryService } from "./service.js";

type InventoryModuleDeps = {
  catalog: CatalogServiceImpl;
};

export const inventoryModule = defineModule<
  {
    inventoryLevels: typeof inventoryLevels;
    inventoryMovements: typeof inventoryMovements;
    warehouses: typeof warehouses;
  },
  InventoryService,
  InventoryModuleDeps
>({
  id: "inventory",
  dependencies: ["catalog"],
  schema: () => ({
    inventoryLevels,
    inventoryMovements,
    warehouses,
  }),
  service: (deps) =>
    new InventoryService({
      repository: new InventoryRepository(deps.db.db as DrizzleDatabase),
      hooks: deps.hooks,
      config: deps.config as CommerceConfig,
      services: deps.services,
      database: deps.db,
    }),
});
