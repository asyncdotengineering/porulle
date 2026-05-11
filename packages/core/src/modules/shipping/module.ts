import type { CommerceConfig } from "../../config/types.js";
import { defineModule } from "../../kernel/module/index.js";
import type { CatalogServiceImpl } from "../catalog/service.js";
import { ShippingService } from "./service.js";

type ShippingModuleDeps = {
  catalog: CatalogServiceImpl;
};

export const shippingModule = defineModule<
  Record<string, never>,
  ShippingService,
  ShippingModuleDeps
>({
  id: "shipping",
  dependencies: ["catalog"],
  schema: () => ({}),
  service: (deps) =>
    new ShippingService({
      config: deps.config as CommerceConfig,
      catalogRepository: deps.services.catalog.repository,
    }),
});
