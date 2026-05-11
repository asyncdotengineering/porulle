import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import type { CatalogRepository } from "../catalog/repository/index.js";
import { PricingRepository } from "./repository/index.js";
import { PricingService } from "./service.js";
import { priceModifiers, prices } from "./schema.js";

type PricingModuleDeps = {
  catalog: {
    repository: CatalogRepository;
  };
};

export const pricingModule = defineModule<
  { prices: typeof prices; priceModifiers: typeof priceModifiers },
  PricingService,
  PricingModuleDeps
>({
  id: "pricing",
  dependencies: ["catalog"],
  schema: () => ({ prices, priceModifiers }),
  service: (deps) =>
    new PricingService({
      repository: new PricingRepository(deps.db.db as DrizzleDatabase),
      catalogRepository: deps.services.catalog.repository,
      hooks: deps.hooks,
      services: deps.services,
      database: deps.db,
    }),
});
