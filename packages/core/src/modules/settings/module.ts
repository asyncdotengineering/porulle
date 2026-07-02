import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import { SettingsRepository } from "./repository/index.js";
import { storeSettings } from "./schema.js";
import { SettingsService } from "./service.js";

export const settingsModule = defineModule<
  { storeSettings: typeof storeSettings },
  SettingsService,
  Record<string, never>
>({
  id: "settings",
  schema: () => ({ storeSettings }),
  service: (deps) =>
    new SettingsService({
      repository: new SettingsRepository(deps.db.db as DrizzleDatabase),
    }),
});
