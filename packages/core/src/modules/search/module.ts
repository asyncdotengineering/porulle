import type { CommerceConfig } from "../../config/types.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
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
      const adapter = config.search?.adapter;
      adapter?.init?.({ db: deps.db.db as PluginDb });
      return new SearchService({
        catalogRepository: deps.services.catalog.repository,
        resolveEntityFieldDefinitions: deps.services.catalog.resolveEntityFieldDefinitions.bind(deps.services.catalog),
        config,
        ...(config.entities ? { entities: config.entities } : {}),
        ...(adapter ? { adapter } : {}),
        ...(config.search?.defaultFacets
          ? { defaultFacets: config.search.defaultFacets }
          : {}),
      });
    },
  },
);
