import type { CommerceConfig } from "../../config/types.js";
import { defineModule } from "../../kernel/module/index.js";
import { PaymentsService } from "./service.js";

export const paymentsModule = defineModule<
  Record<string, never>,
  PaymentsService,
  Record<string, never>
>({
  id: "payments",
  schema: () => ({}),
  service: (deps) =>
    new PaymentsService((deps.config as CommerceConfig).payments),
});
