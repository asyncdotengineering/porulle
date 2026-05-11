import type { CommerceConfig } from "../../config/types.js";
import { defineModule } from "../../kernel/module/index.js";
import type { CatalogServiceImpl } from "../catalog/service.js";
import { SearchService } from "./service.js";

type SearchModuleDeps = {
  catalog: CatalogServiceImpl;
};

export const searchModule = defineModule<Record<string, never>, SearchService, SearchModuleDeps>(
  {
    id: "search",
    dependencies: ["catalog"],
    schema: () => ({}),
    service: (deps) => {
      const config = deps.config as CommerceConfig;
      return new SearchService({
        catalogRepository: deps.services.catalog.repository,
        ...(config.search?.adapter ? { adapter: config.search.adapter } : {}),
        ...(config.search?.defaultFacets
          ? { defaultFacets: config.search.defaultFacets }
          : {}),
      });
    },
  },
);
