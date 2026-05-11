import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import { DrizzleAnalyticsAdapter } from "./drizzle-adapter.js";
import { BUILTIN_ANALYTICS_MODELS } from "./models.js";
import { AnalyticsService } from "./service.js";

export const analyticsModule = defineModule<
  Record<string, never>,
  AnalyticsService,
  Record<string, never>
>({
  id: "analytics",
  schema: () => ({}),
  service: (deps) => {
    const adapter = new DrizzleAnalyticsAdapter(deps.db.db as DrizzleDatabase);
    for (const model of BUILTIN_ANALYTICS_MODELS) {
      adapter.registerModel(model);
    }
    return new AnalyticsService({
      adapter,
      config: deps.config as CommerceConfig,
    });
  },
});
