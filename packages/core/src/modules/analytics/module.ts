import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import type { SettingsService } from "../settings/service.js";
import { DrizzleAnalyticsAdapter } from "./drizzle-adapter.js";
import { BUILTIN_ANALYTICS_MODELS } from "./models.js";
import { RetailReportsEngine } from "./reports.js";
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
    // Settings is resolved lazily from the shared service container — the
    // settings module may instantiate after analytics.
    const services = deps.services as Record<string, unknown>;
    const reports = new RetailReportsEngine(
      deps.db.db as DrizzleDatabase,
      (orgId, group) => (services.settings as SettingsService).read(orgId, group),
    );
    return new AnalyticsService({
      adapter,
      config: deps.config as CommerceConfig,
      reports,
    });
  },
});
