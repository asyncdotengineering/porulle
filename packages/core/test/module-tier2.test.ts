import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { HookRegistry } from "../src/kernel/hooks/registry.js";
import type { ModuleDeps } from "../src/kernel/module/index.js";
import { CatalogRepository } from "../src/modules/catalog/repository/index.js";
import { catalogModule } from "../src/modules/catalog/module.js";
import { CatalogServiceImpl } from "../src/modules/catalog/service.js";
import { inventoryModule } from "../src/modules/inventory/module.js";
import { InventoryService } from "../src/modules/inventory/service.js";
import { PricingService } from "../src/modules/pricing/service.js";
import { pricingModule } from "../src/modules/pricing/index.js";

function tier2Deps<TDeps extends Record<string, unknown> = Record<string, unknown>>(
  services: TDeps,
): ModuleDeps<TDeps> {
  const adapter: DatabaseAdapter = {
    provider: "test",
    db: {} as DrizzleDatabase,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
  };
  return {
    db: adapter,
    hooks: new HookRegistry(),
    services,
    config: {},
    logger,
  };
}

function acceptCatalog(s: CatalogServiceImpl) {
  return s;
}

function acceptInventory(s: InventoryService) {
  return s;
}

function acceptPricing(s: PricingService) {
  return s;
}

describe("tier-2 defineModule", () => {
  it("catalogModule declares pricing dependency and typed services", () => {
    expect(catalogModule.id).toBe("catalog");
    expect(catalogModule.dependencies).toEqual(["pricing"]);

    const catalogRepo = new CatalogRepository({} as DrizzleDatabase);
    const pricing = pricingModule.service(
      tier2Deps({
        catalog: { repository: catalogRepo },
      }),
    );
    acceptPricing(pricing);

    const catalogDeps = tier2Deps({ pricing });
    acceptPricing(catalogDeps.services.pricing);
    const catalog = catalogModule.service(catalogDeps);
    acceptCatalog(catalog);
    expect(catalog).toBeInstanceOf(CatalogServiceImpl);
  });

  it("inventoryModule declares catalog dependency and typed services", () => {
    expect(inventoryModule.id).toBe("inventory");
    expect(inventoryModule.dependencies).toEqual(["catalog"]);

    const catalogRepo = new CatalogRepository({} as DrizzleDatabase);
    const pricing = pricingModule.service(
      tier2Deps({
        catalog: { repository: catalogRepo },
      }),
    );
    const catalog = catalogModule.service(tier2Deps({ pricing }));

    const invDeps = tier2Deps({ catalog });
    acceptCatalog(invDeps.services.catalog);
    const inv = inventoryModule.service(invDeps);
    acceptInventory(inv);
    expect(inv).toBeInstanceOf(InventoryService);
  });
});
