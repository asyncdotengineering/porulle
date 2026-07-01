import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import { TaxRatesRepository } from "./repository/index.js";
import { taxRates } from "./schema.js";
import { TaxService } from "./service.js";

export const taxModule = defineModule<
  { taxRates: typeof taxRates },
  TaxService,
  Record<string, never>
>({
  id: "tax",
  schema: () => ({ taxRates }),
  service: (deps) =>
    new TaxService({
      adapter: (deps.config as CommerceConfig).tax?.adapter,
      repository: new TaxRatesRepository(deps.db.db as DrizzleDatabase),
    }),
});
