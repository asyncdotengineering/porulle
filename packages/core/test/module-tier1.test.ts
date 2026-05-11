import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { HookRegistry } from "../src/kernel/hooks/registry.js";
import type { ModuleDeps } from "../src/kernel/module/index.js";
import { CatalogRepository } from "../src/modules/catalog/repository/index.js";
import { CustomerService } from "../src/modules/customers/service.js";
import { customersModule } from "../src/modules/customers/index.js";
import { PricingService } from "../src/modules/pricing/service.js";
import { pricingModule } from "../src/modules/pricing/index.js";

function tier1Deps<TDeps extends Record<string, unknown> = Record<string, unknown>>(
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

function acceptCustomer(s: CustomerService) {
  return s;
}

function acceptPricing(s: PricingService) {
  return s;
}

function acceptCatalogRepository(r: CatalogRepository) {
  return r;
}

describe("tier-1 defineModule", () => {
  it("customersModule id and service type", () => {
    expect(customersModule.id).toBe("customers");
    const svc = customersModule.service(tier1Deps({}));
    acceptCustomer(svc);
    expect(svc).toBeInstanceOf(CustomerService);
  });

  it("pricingModule declares catalog dependency and service type", () => {
    expect(pricingModule.id).toBe("pricing");
    expect(pricingModule.dependencies).toEqual(["catalog"]);

    const catalogRepository = new CatalogRepository({} as DrizzleDatabase);
    const deps = tier1Deps({
      catalog: {
        repository: catalogRepository,
      },
    });

    acceptCatalogRepository(deps.services.catalog.repository);
    const svc = pricingModule.service(deps);
    acceptPricing(svc);
    expect(svc).toBeInstanceOf(PricingService);
  });
});
