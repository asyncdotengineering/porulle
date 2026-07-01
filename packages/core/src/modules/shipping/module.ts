import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import type { CatalogServiceImpl } from "../catalog/service.js";
import { ShippingConfigRepository } from "./repository/index.js";
import { shippingZones, shippingRates } from "./schema.js";
import { ShippingService } from "./service.js";

type ShippingModuleDeps = {
  catalog: CatalogServiceImpl;
};

export const shippingModule = defineModule<
  { shippingZones: typeof shippingZones; shippingRates: typeof shippingRates },
  ShippingService,
  ShippingModuleDeps
>({
  id: "shipping",
  dependencies: ["catalog"],
  schema: () => ({ shippingZones, shippingRates }),
  service: (deps) =>
    new ShippingService({
      config: deps.config as CommerceConfig,
      catalogRepository: deps.services.catalog.repository,
      repository: new ShippingConfigRepository(deps.db.db as DrizzleDatabase),
    }),
});
