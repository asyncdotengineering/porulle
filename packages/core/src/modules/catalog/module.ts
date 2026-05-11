import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import type { PricingService } from "../pricing/service.js";
import { CatalogRepository } from "./repository/index.js";
import {
  brands,
  categories,
  entityBrands,
  entityCategories,
  optionTypes,
  optionValues,
  sellableAttributes,
  sellableCustomFields,
  sellableEntities,
  variantOptionValues,
  variants,
} from "./schema.js";
import { CatalogServiceImpl } from "./service.js";

type CatalogModuleDeps = {
  pricing: PricingService;
};

export const catalogModule = defineModule<
  {
    sellableEntities: typeof sellableEntities;
    sellableAttributes: typeof sellableAttributes;
    sellableCustomFields: typeof sellableCustomFields;
    categories: typeof categories;
    entityCategories: typeof entityCategories;
    brands: typeof brands;
    entityBrands: typeof entityBrands;
    optionTypes: typeof optionTypes;
    optionValues: typeof optionValues;
    variants: typeof variants;
    variantOptionValues: typeof variantOptionValues;
  },
  CatalogServiceImpl,
  CatalogModuleDeps
>({
  id: "catalog",
  dependencies: ["pricing"],
  schema: () => ({
    sellableEntities,
    sellableAttributes,
    sellableCustomFields,
    categories,
    entityCategories,
    brands,
    entityBrands,
    optionTypes,
    optionValues,
    variants,
    variantOptionValues,
  }),
  service: (deps) =>
    new CatalogServiceImpl({
      repository: new CatalogRepository(deps.db.db as DrizzleDatabase),
      hooks: deps.hooks,
      config: deps.config as CommerceConfig,
      services: deps.services,
      database: deps.db,
    }),
});
