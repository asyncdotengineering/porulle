import type { CommerceConfig } from "../../config/types.js";
import { defineModule } from "../../kernel/module/index.js";
import { TaxService } from "./service.js";

export const taxModule = defineModule<
  Record<string, never>,
  TaxService,
  Record<string, never>
>({
  id: "tax",
  schema: () => ({}),
  service: (deps) =>
    new TaxService({
      adapter: (deps.config as CommerceConfig).tax?.adapter,
    }),
});
