import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import type { InventoryService } from "../inventory/service.js";
import { OrdersRepository } from "../orders/repository/index.js";
import { FulfillmentRepository } from "./repository/index.js";
import {
  fulfillmentEvents,
  fulfillmentLineItems,
  fulfillmentRecords,
} from "./schema.js";
import { FulfillmentService } from "./service.js";

type FulfillmentModuleDeps = {
  inventory: InventoryService;
};

export const fulfillmentModule = defineModule<
  {
    fulfillmentRecords: typeof fulfillmentRecords;
    fulfillmentLineItems: typeof fulfillmentLineItems;
    fulfillmentEvents: typeof fulfillmentEvents;
  },
  FulfillmentService,
  FulfillmentModuleDeps
>({
  id: "fulfillment",
  dependencies: ["inventory"],
  schema: () => ({
    fulfillmentRecords,
    fulfillmentLineItems,
    fulfillmentEvents,
  }),
  service: (deps) =>
    new FulfillmentService({
      repository: new FulfillmentRepository(deps.db.db as DrizzleDatabase),
      ordersRepository: new OrdersRepository(deps.db.db as DrizzleDatabase),
      inventoryService: deps.services.inventory,
      hooks: deps.hooks,
      services: deps.services,
      database: deps.db,
    }),
});
